import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateCandidates, refreshResearchCache } from './src/research.js';
import { selectTopics } from './src/select.js';
import { writePost } from './src/writer.js';
import { supabase } from './src/supabaseClient.js';
import { markdownToBlocks, computeReadTime } from './src/markdownToBlocks.js';
import { registerDiscordRoutes } from './src/discordInteractions.js';

dotenv.config();

// Resolve paths relative to this file (not the CWD) so static serving works the
// same whether run directly on Render or bundled into a Vercel serverless function.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// Discord interactions endpoint — MUST be registered BEFORE the global
// express.json() below. Discord's Ed25519 signature verification needs the raw,
// unparsed request body; if express.json() ran first it would consume the
// stream and verification would fail with a misleading 401. This route fully
// handles its own response, so it never falls through to the JSON parser, and
// no other route is affected (they are all registered after express.json()).
registerDiscordRoutes(app);

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

// Sends a Discord notification via webhook, if DISCORD_WEBHOOK_URL is set.
// Awaited (so it finishes before a serverless function returns) but non-fatal:
// a missing URL is skipped silently, and any failure is logged, never thrown.
async function notifyDiscord(content) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Discord caps message content at 2000 chars.
      body: JSON.stringify({ content: String(content).slice(0, 1990) })
    });
    if (!resp.ok) console.warn(`[discord] Webhook responded ${resp.status}`);
  } catch (err) {
    console.warn('[discord] Notification failed:', err.message);
  }
}

// Scheduled research-cache refresh (Vercel cron). Authenticated by CRON_SECRET,
// which Vercel injects as "Authorization: Bearer <CRON_SECRET>" on cron
// requests — NOT the Supabase session — so it is registered BEFORE the
// requireAuth gate below. It regenerates the recent-topics research, stores it
// in Supabase (nothing is written to the posts table), and pings Discord.
app.get('/api/cron/refresh-topics', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    console.log('[cron] Refreshing research cache...');
    const candidates = await refreshResearchCache();
    console.log(`[cron] Research cache refreshed: ${candidates.length} candidates.`);

    // Notify Discord that fresh topics were generated (non-fatal).
    const appUrl = process.env.APP_URL || 'https://melsoft-blog.vercel.app';
    const list = candidates.slice(0, 10).map((c, i) => `${i + 1}. ${c.title}`).join('\n');
    const message = candidates.length
      ? `🔔 **Fresh blog topics generated** — ${candidates.length} new candidate${candidates.length === 1 ? '' : 's'}\n\n👉 **Open the blog agent:** ${appUrl}\n\n${list}`
      : `🔔 Topic research ran but found no recent candidates this time.\n\n👉 **Open the blog agent:** ${appUrl}`;
    await notifyDiscord(message);

    return res.json({ ok: true, refreshedAt: new Date().toISOString(), count: candidates.length });
  } catch (err) {
    console.error('[cron] Refresh failed:', err);
    return res.status(500).json({ error: 'Refresh failed', details: err.message });
  }
});

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
