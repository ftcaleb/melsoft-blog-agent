import express from 'express';
import dotenv from 'dotenv';
import { generateCandidates } from './src/research.js';
import { selectTopics } from './src/select.js';
import { writePost } from './src/writer.js';

dotenv.config();

// Dynamically import logPost from logger.js to handle the case where it is empty or unimplemented
let logPost = async (postData) => {
  console.log('[logger fallback] logPost stub triggered (logger.js not yet implemented). Mock logging:', postData.title);
};

try {
  const loggerModule = await import('./src/logger.js');
  if (loggerModule.logPost) {
    logPost = loggerModule.logPost;
  }
} catch (e) {
  console.warn('[logger] Dynamic logger import failed, using stub.', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parsing middleware
app.use(express.json());

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

    console.log(`[API POST /api/approve] Post generated. Logging to post_log.json...`);
    await logPost({
      title: post.title,
      slug: post.slug,
      pillar: post.pillar,
      type: post.type,
      sourceTopic: post.sourceTopic
    });

    console.log(`[API POST /api/approve] Post generated and logged: ${post.slug}\n`);

    res.json({ success: true, post });
  } catch (error) {
    console.error('[API POST /api/approve] Error generating/logging post:', error);
    res.status(500).json({ error: 'Failed to generate blog post', details: error.message });
  }
});

// Serve static files from the public folder
app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
