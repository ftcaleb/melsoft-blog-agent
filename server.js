import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateCandidates } from './src/research.js';
import { selectTopics } from './src/select.js';
import { writePost } from './src/writer.js';
import { supabase } from './src/supabaseClient.js';
import { markdownToBlocks, computeReadTime } from './src/markdownToBlocks.js';

dotenv.config();

// Resolve paths relative to this file (not the CWD) so static serving works the
// same whether run directly on Render or bundled into a Vercel serverless function.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parsing middleware
app.use(express.json());

// Serve static files from the public folder. These are HTML/CSS/JS shells with
// no secrets; access control is enforced on the billed API below (and by each
// page's own Supabase login), so the static assets themselves are open.
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Supabase auth gate for the billed API.
// Every /api request must carry a valid Supabase access token
// (Authorization: Bearer <token>) from a logged-in user. This is the single
// login flow — the same Supabase session both pages use — and it stops anyone
// with the public URL from draining the Anthropic key.
// ---------------------------------------------------------------------------
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    }

    req.user = data.user;
    next();
  } catch (err) {
    console.error('[auth] Token verification failed:', err);
    return res.status(401).json({ error: 'Authentication check failed' });
  }
}

app.use('/api', requireAuth);

// In-flight lock: coalesces concurrent/rapid /api/topics requests into a single
// run so a spammed refresh button (or parallel tabs) can't trigger multiple
// billed research passes at once. All callers awaiting during a run get the
// same result.
let topicsInFlight = null;

// API endpoint to retrieve the 3 selected blog topic candidates.
// Pass ?fresh=true to bypass the 24h research cache and force live regeneration.
app.get('/api/topics', async (req, res) => {
  try {
    const forceFresh = req.query.fresh === 'true';

    if (topicsInFlight) {
      console.log('[API GET /api/topics] Request already in flight — coalescing (no extra API call).');
      const result = await topicsInFlight;
      return res.json(result);
    }

    topicsInFlight = (async () => {
      console.log(`[API GET /api/topics] Generating candidate topics${forceFresh ? ' (forceFresh — bypassing cache)' : ''}...`);
      const allCandidates = await generateCandidates({ forceFresh });
      console.log(`[API GET /api/topics] Total candidates generated: ${allCandidates.length}`);

      console.log('[API GET /api/topics] Selecting top 3 topics...');
      const selectedTopics = selectTopics(allCandidates);

      console.log('[API GET /api/topics] Successfully selected 3 topics:');
      selectedTopics.forEach((t, i) => {
        console.log(`  ${i + 1}. [${t.pillar.toUpperCase()} | ${t.type.toUpperCase()}] ${t.title}`);
      });

      return { topics: selectedTopics };
    })();

    const result = await topicsInFlight;
    res.json(result);
  } catch (error) {
    console.error('[API GET /api/topics] Error generating/selecting topics:', error);
    res.status(500).json({ error: 'Failed to generate topics', details: error.message });
  } finally {
    topicsInFlight = null;
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
    const body = markdownToBlocks(post.bodyMarkdown, post.title);
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
      source_topic: post.sourceTopic,
      type: post.type
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

// Start a real HTTP server only when this file is run directly (e.g. `npm start`
// on Render, or local dev). On Vercel the app is imported by api/index.js and
// invoked per-request, so app.listen must NOT run in that environment.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

// Exported so a Vercel serverless function (api/index.js) can use the Express
// app as its request handler.
export default app;
