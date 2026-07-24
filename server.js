import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateCandidates, refreshResearchCache } from './src/research.js';
import { selectTopics } from './src/select.js';
import { writePost } from './src/writer.js';
import { supabase } from './src/supabaseClient.js';
import { markdownToBlocks, computeReadTime } from './src/markdownToBlocks.js';
import { registerDiscordRoutes, topicHash } from './src/discordInteractions.js';

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

// Discord message-component constants (see discord.com/developers component docs).
const DISCORD_ACTION_ROW = 1; // component type: a row that holds up to 5 buttons
const DISCORD_BUTTON = 2; // component type: a button
const DISCORD_BUTTON_PRIMARY = 1; // button style: filled/primary
const DISCORD_CUSTOM_ID_MAX = 100; // hard limit on a component custom_id
const DISCORD_BUTTONS_PER_ROW = 5; // max buttons in one action row
const DISCORD_MAX_BUTTON_ROWS = 5; // max action rows in one message

// Builds "Generate #N" button rows for the given topics, matching the numbering
// used in the notification's text list. Each button's custom_id is
// `generate:h:<hash>` — a SHORT reference the Discord interactions handler
// resolves back to the exact topic before drafting it.
//
// Why a hash and not the title: Discord caps custom_id at 100 chars and titles
// routinely run 90–120, so embedding the full title silently dropped almost
// every button (only a title <= 91 chars survived). A hash is always ~19 chars,
// so every button renders — and unlike an index it can never resolve to a
// different topic if the topic list is refreshed before someone clicks.
export function buildTopicButtons(candidates) {
  const rows = [];
  let current = null;
  const skipped = [];

  for (let i = 0; i < candidates.length; i++) {
    const title = String(candidates[i] && candidates[i].title || '').trim();
    if (!title) continue;

    const customId = `generate:h:${topicHash(title)}`;
    if (customId.length > DISCORD_CUSTOM_ID_MAX) {
      skipped.push(i + 1); // unreachable in practice; kept as a guard
      continue;
    }

    if (!current || current.components.length >= DISCORD_BUTTONS_PER_ROW) {
      if (rows.length >= DISCORD_MAX_BUTTON_ROWS) break; // out of room for more rows
      current = { type: DISCORD_ACTION_ROW, components: [] };
      rows.push(current);
    }

    current.components.push({
      type: DISCORD_BUTTON,
      style: DISCORD_BUTTON_PRIMARY,
      label: `Generate #${i + 1}`,
      custom_id: customId,
    });
  }

  if (skipped.length) {
    console.log(`[discord] Skipped Generate buttons for long-title topic(s): #${skipped.join(', #')} (still listed; draftable via /generate).`);
  }
  return rows;
}

// Sends a Discord notification. Awaited (so it finishes before a serverless
// function returns) but non-fatal: everything is logged, never thrown.
//
// Two delivery paths, chosen automatically:
//   1. BOT-TOKEN channel message — used when interactive `components` (buttons)
//      are present AND both DISCORD_CHANNEL_ID and DISCORD_BOT_TOKEN are set.
//      Components render natively on bot-sent messages (no ?with_components=true
//      and no special flag). A plain channel webhook is NOT application-owned
//      and cannot render interactive buttons, so this is the only path that can.
//   2. WEBHOOK (DISCORD_WEBHOOK_URL) — the original behaviour, used when there
//      are no components, or when the bot path is unconfigured or fails. When
//      components are absent this is byte-for-byte the original plain-text post.
//
// The bot token is used only as an Authorization header — never logged, printed,
// or included in any error message.
export async function notifyDiscord(content, components) {
  // Discord caps message content at 2000 chars.
  const contentStr = String(content).slice(0, 1990);
  const hasComponents = Array.isArray(components) && components.length > 0;

  const botToken = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  // Path 1: bot-token channel message (only when we have buttons to render and
  // the bot is configured). On success we're done; on failure we fall through
  // to the webhook path so a notification is never lost.
  if (hasComponents && botToken && channelId) {
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${botToken}`,
        },
        body: JSON.stringify({ content: contentStr, components }),
      });
      if (resp.ok) return;
      // Log status only — never the token or headers.
      console.warn(`[discord] Bot channel message responded ${resp.status}; falling back to webhook.`);
    } catch (err) {
      console.warn('[discord] Bot channel message failed:', err.message);
    }
  }

  // Path 2: webhook fallback (original behaviour). Skipped silently if no URL.
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const base = { content: contentStr };

  const send = (payload, withComponents) => {
    const endpoint = withComponents
      ? url + (url.includes('?') ? '&' : '?') + 'with_components=true'
      : url;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  try {
    let resp;
    if (hasComponents) {
      resp = await send({ ...base, components }, true);
      if (!resp.ok) {
        console.warn(`[discord] Webhook with components responded ${resp.status}; retrying as plain text.`);
        resp = await send(base, false);
      }
    } else {
      resp = await send(base, false);
    }
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

    // Notify Discord with the SAME three topics the dashboard would show —
    // selectTopics() applies the fixed 2 tech + 1 skills rule — rather than the
    // raw candidate list. Each of the three gets a "Generate #N" button whose
    // numbering matches the list. Non-fatal: any failure here is logged, and the
    // cache refresh above still counts as a success.
    const appUrl = process.env.APP_URL || 'https://melsoft-blog.vercel.app';

    let selected = [];
    if (candidates.length) {
      try {
        // Re-read through generateCandidates so evergreen topics and the
        // already-covered dedup are applied, exactly like GET /api/topics.
        const pool = await generateCandidates({ forceFresh: false });
        selected = selectTopics(pool);
      } catch (selErr) {
        // Not enough candidates in a pillar — fall back to a plain heads-up.
        console.warn('[cron] Could not select 3 topics:', selErr.message);
      }
    }

    let message;
    let buttons;
    if (selected.length) {
      const list = selected
        .map((t, i) => `${i + 1}. \`[${String(t.pillar || '?').toUpperCase()} | ${String(t.type || '?').toUpperCase()}]\` ${t.title}`)
        .join('\n');
      buttons = buildTopicButtons(selected);
      message =
        `🔔 **Fresh blog topics ready** — ${selected.length} selected for review\n\n` +
        `👉 **Open the blog agent:** ${appUrl}\n\n${list}\n\n` +
        `🖱️ Tap a button below to draft that topic here in Discord.`;
    } else {
      message =
        `🔔 Topic research ran but no topics could be selected this time.\n\n` +
        `👉 **Open the blog agent:** ${appUrl}`;
    }
    await notifyDiscord(message, buttons);

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

    // Persist the topic cluster for per-cluster performance reporting (Deliverable
    // 6/7). Done as a separate best-effort update so a missing `cluster` column
    // (before the one-time ALTER TABLE is run) only warns — it never fails the
    // draft save. Once the column exists this populates automatically.
    if (post.cluster) {
      const { error: clusterErr } = await supabase
        .from('posts')
        .update({ cluster: post.cluster })
        .eq('id', data.id);
      if (clusterErr) {
        console.warn(`[API POST /api/approve] Could not persist cluster "${post.cluster}" (is the 'cluster' column added?): ${clusterErr.message}`);
      }
    }

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
