import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { generateCandidates } from './src/research.js';
import { selectTopics } from './src/select.js';
import { writePost } from './src/writer.js';
import { supabase } from './src/supabaseClient.js';
import { markdownToBlocks, computeReadTime } from './src/markdownToBlocks.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parsing middleware
app.use(express.json());

// Serve static files from the public folder
app.use(express.static('public'));

// API endpoint to retrieve the 3 selected blog topic candidates
app.get('/api/topics', async (req, res) => {
  try {
    console.log('[API GET /api/topics] Generating candidate topics...');
    const allCandidates = await generateCandidates();
    console.log(`[API GET /api/topics] Total candidates generated: ${allCandidates.length}`);

    console.log('[API GET /api/topics] Selecting top 3 topics...');
    const selectedTopics = selectTopics(allCandidates);
    
    console.log('[API GET /api/topics] Successfully selected 3 topics:');
    selectedTopics.forEach((t, i) => {
      console.log(`  ${i + 1}. [${t.pillar.toUpperCase()} | ${t.type.toUpperCase()}] ${t.title}`);
    });

    res.json({ topics: selectedTopics });
  } catch (error) {
    console.error('[API GET /api/topics] Error generating/selecting topics:', error);
    res.status(500).json({ error: 'Failed to generate topics', details: error.message });
  }
});

// API endpoint to approve a selected topic and write the full blog post
app.post('/api/approve', async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic || !topic.title) {
      return res.status(400).json({ error: 'Missing or invalid topic parameter' });
    }

    console.log(`\n[API POST /api/approve] Writing post for: "${topic.title}"...`);
    const post = await writePost(topic);

    console.log(`[API POST /api/approve] Converting markdown to blocks and computing read time...`);
    const body = markdownToBlocks(post.bodyMarkdown);
    const readTime = computeReadTime(post.bodyMarkdown);

    const postData = {
      status: 'draft',
      slug: post.slug,
      title: post.title,
      excerpt: post.metaDescription,
      body: body,
      read_time: readTime,
      raw_markdown: post.bodyMarkdown,
      pillar: post.pillar,
      source_topic: post.sourceTopic
    };

    console.log(`[API POST /api/approve] Inserting draft post into Supabase...`);
    let { data, error } = await supabase
      .from('posts')
      .insert([postData])
      .select()
      .single();

    if (error) {
      // Postgres unique violation error code is 23505
      if (error.code === '23505') {
        console.log(`[API POST /api/approve] Duplicate slug detected: "${postData.slug}". Retrying insertion with unique suffix...`);
        postData.slug = post.slug + '-' + Date.now().toString(36).slice(-4);
        
        const retryResult = await supabase
          .from('posts')
          .insert([postData])
          .select()
          .single();
          
        if (retryResult.error) {
          console.error('[API POST /api/approve] Retry insert failed:', retryResult.error);
          return res.status(500).json({ error: 'Failed to save draft', details: retryResult.error.message });
        }
        
        data = retryResult.data;
      } else {
        console.error('[API POST /api/approve] Supabase insert failed:', error);
        return res.status(500).json({ error: 'Failed to save draft', details: error.message });
      }
    }

    console.log(`[API POST /api/approve] Draft successfully saved to Supabase (ID: ${data.id}, Slug: ${data.slug})`);
    res.json({ success: true, draftId: data.id, slug: data.slug });
  } catch (error) {
    console.error('[API POST /api/approve] Error generating/logging post:', error);
    res.status(500).json({ error: 'Failed to save draft', details: error.message });
  }
});

// API endpoint to publish a draft to the local preview site and toggle DB status
app.post('/api/publish', async (req, res) => {
  const { draftId } = req.body;
  if (!draftId) {
    return res.status(400).json({ error: 'Missing draftId parameter' });
  }

  console.log(`\n[API POST /api/publish] Fetching draft row for publication: ID ${draftId}...`);

  try {
    // 1. Fetch from Supabase
    const { data: draft, error: fetchError } = await supabase
      .from('posts')
      .select('*')
      .eq('id', draftId)
      .single();

    if (fetchError || !draft) {
      console.error('[API POST /api/publish] Draft not found or fetch error:', fetchError);
      return res.status(404).json({ error: 'Draft not found', details: fetchError ? fetchError.message : '' });
    }

    // 2. Check if already published
    if (draft.status === 'published') {
      console.warn(`[API POST /api/publish] Draft ID ${draftId} is already published`);
      return res.status(400).json({ error: 'Draft is already published' });
    }

    // 3. Build Post object in template shape
    const postObject = {
      slug: draft.slug,
      title: draft.title,
      excerpt: draft.excerpt,
      category: draft.category,
      readTime: draft.read_time,
      date: draft.post_date,
      author: draft.author,
      authorRole: draft.author_role,
      tint: draft.tint,
      image: draft.image,
      body: draft.body // jsonb array
    };

    // 4. File Path config
    const targetPath = 'C:\\Users\\brend\\melsoft-website\\src\\generatedPosts.js';
    console.log(`[API POST /api/publish] Reading local preview generatedPosts.js from: ${targetPath}`);

    let fileContent;
    try {
      fileContent = await fs.readFile(targetPath, 'utf8');
    } catch (readErr) {
      console.error('[API POST /api/publish] Failed to read generatedPosts.js:', readErr);
      return res.status(500).json({ error: 'Failed to publish draft', details: `Failed to read target file: ${readErr.message}` });
    }

    // 5. Insert new post as the first element of the array
    const targetStr = 'export const GENERATED_POSTS = [';
    const idx = fileContent.indexOf(targetStr);
    if (idx === -1) {
      console.error('[API POST /api/publish] Target prefix not found in generatedPosts.js');
      return res.status(500).json({ error: 'Failed to publish draft', details: 'Target array definition "export const GENERATED_POSTS = [" was not found in generatedPosts.js' });
    }

    const insertPos = idx + targetStr.length;
    const serialized = JSON.stringify(postObject, null, 2)
      .split('\n')
      .map(line => '  ' + line)
      .join('\n');

    const afterBracket = fileContent.substring(insertPos).trim();
    const hasExistingElements = !afterBracket.startsWith(']');
    const comma = hasExistingElements ? ',' : '';

    const newContent = fileContent.substring(0, insertPos) +
      '\n' + serialized + comma +
      fileContent.substring(insertPos);

    // 6. Write back to disk
    console.log('[API POST /api/publish] Writing updated generatedPosts.js content...');
    try {
      await fs.writeFile(targetPath, newContent, 'utf8');
    } catch (writeErr) {
      console.error('[API POST /api/publish] Failed to write generatedPosts.js:', writeErr);
      return res.status(500).json({ error: 'Failed to publish draft', details: `Failed to write target file: ${writeErr.message}` });
    }

    // 7. Update database row status & published_at
    console.log('[API POST /api/publish] Flipping status to published in Supabase...');
    const { error: updateError } = await supabase
      .from('posts')
      .update({
        status: 'published',
        published_at: new Date().toISOString()
      })
      .eq('id', draftId);

    if (updateError) {
      console.error('[API POST /api/publish] Database update failed:', updateError);
      return res.status(500).json({ error: 'File updated successfully, but failed to update status in database', details: updateError.message });
    }

    console.log('[API POST /api/publish] Post successfully published to local preview site!');
    res.json({ success: true, message: 'Published to local preview site' });

  } catch (err) {
    console.error('[API POST /api/publish] Server crash during publishing:', err);
    res.status(500).json({ error: 'Failed to publish draft', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
