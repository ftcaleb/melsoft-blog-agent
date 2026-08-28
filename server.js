import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateCandidates, refreshResearchCache } from './src/research.js';
import { selectTopics, selectTopicsForPillar, pillarForDate } from './src/select.js';
import { writePost, PostValidationError, formatPostDate } from './src/writer.js';
import { supabase } from './src/supabaseClient.js';
import { markdownToBlocks, computeReadTime } from './src/markdownToBlocks.js';
import { registerDiscordRoutes, topicHash } from './src/discordInteractions.js';
import { notifyDiscord, notifyFailure } from './src/notify.js';
import { generateFeaturedImageSafe, regenerateImageForDraft, ImageGenerationError } from './src/imageGen.js';

// Re-exported for backwards compatibility: scripts/testDiscordNotify.js imports
// notifyDiscord from here. The implementation now lives in src/notify.js so
// modules that server.js imports can alert without a circular dependency.
export { notifyDiscord };

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

    // One post a day, 5 a week: the weekday decides the pillar (3 skills + 2
    // tech per week). Off-schedule manual runs (weekends) fall back to skills,
    // the majority pillar, so a manual trigger still produces useful options.
    const now = new Date();
    const scheduled = pillarForDate(now);
    const targetPillar = scheduled || 'skills';
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getUTCDay()];
    const pillarLabel = targetPillar === 'skills' ? 'SKILLS DEVELOPMENT' : 'TECH';

    let selected = [];
    if (candidates.length) {
      try {
        // Re-read through generateCandidates so evergreen topics and the
        // already-covered dedup are applied, exactly like GET /api/topics.
        const pool = await generateCandidates({ forceFresh: false });
        selected = selectTopicsForPillar(pool, targetPillar, 3);
      } catch (selErr) {
        console.warn(`[cron] Could not select ${targetPillar} topics:`, selErr.message);
      }
    }
    console.log(`[cron] ${dayName} → ${targetPillar} day; offering ${selected.length} topic(s).`);

    let message;
    let buttons;
    if (selected.length) {
      const list = selected
        .map((t, i) => `${i + 1}. \`[${String(t.type || '?').toUpperCase()}]\` ${t.title}`)
        .join('\n');
      buttons = buildTopicButtons(selected);
      message =
        `🔔 **${dayName} — ${pillarLabel} day**\n` +
        `_Weekly plan: 3 skills development · 2 tech (one post per weekday)._\n\n` +
        `👉 **Open the blog agent:** ${appUrl}\n\n${list}\n\n` +
        `🖱️ Tap a button below to draft that topic here in Discord.`;
    } else {
      message =
        `🔔 **${dayName} — ${pillarLabel} day**\n\n` +
        `Topic research ran but no ${targetPillar} topics were available today.\n\n` +
        `👉 **Open the blog agent:** ${appUrl}`;
    }
    // mention: true — this is the unattended daily run. Without a ping the
    // message is easy to miss entirely, and the whole flow depends on someone
    // noticing the day's topics are ready.
    await notifyDiscord(message, buttons, { mention: true });

    return res.json({ ok: true, refreshedAt: new Date().toISOString(), count: candidates.length });
  } catch (err) {
    console.error('[cron] Refresh failed:', err);
    // The cron calls refreshResearchCache() directly, so a failure here bypasses
    // the stale-cache fallback (and its alert) in getRecentCandidatesCached().
    // Without this, an unattended cron failure would be a silent 500 — exactly
    // the blind spot that let the original incident reach the live site.
    await notifyFailure(
      'Scheduled topic research',
      'The cron refresh failed. The existing cached topics were NOT overwritten.',
      [err.message]
    );
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

    // Optional ?pillar=tech|skills targets a single pillar (the daily plan:
    // 3 skills + 2 tech per week). Pass ?pillar=today to follow the weekday
    // schedule. Omit it for the original mixed 2 tech + 1 skills set.
    const pillarParam = String(req.query.pillar || '').toLowerCase();
    const targetPillar =
      pillarParam === 'today' ? (pillarForDate(new Date()) || 'skills')
      : (pillarParam === 'tech' || pillarParam === 'skills') ? pillarParam
      : null;

    topicsInFlight = (async () => {
      console.log(`[API GET /api/topics] Generating candidate topics${forceFresh ? ' (forceFresh — bypassing cache)' : ''}...`);
      const allCandidates = await generateCandidates({ forceFresh });
      console.log(`[API GET /api/topics] Total candidates generated: ${allCandidates.length}`);

      console.log(`[API GET /api/topics] Selecting top 3 topics${targetPillar ? ` (${targetPillar} only)` : ''}...`);
      const selectedTopics = targetPillar
        ? selectTopicsForPillar(allCandidates, targetPillar, 3)
        : selectTopics(allCandidates);

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

    // The featured image is generated CONCURRENTLY with the article, not after
    // it. Run sequentially the two would routinely exceed Vercel's 60s
    // maxDuration — writePost alone takes 30-60s — turning a working draft into
    // a timeout. The image prompt is derived from the TOPIC, not the finished
    // article, so there is nothing to wait for.
    //
    // generateFeaturedImageSafe never rejects: if generation or upload fails the
    // post is still saved, just without a hero, exactly as before images were
    // automated. A written article must never be lost over a decorative asset.
    //
    // Trade-off accepted: if writePost then fails its content gate, the image
    // has already been generated and is orphaned in storage. That costs one
    // image and no correctness — the alternative is paying the latency of
    // running them in series on every single request.
    const imagePromise = generateFeaturedImageSafe(topic);

    const post = await writePost(topic);

    console.log(`[API POST /api/approve] Converting markdown to blocks and computing read time...`);
    const body = markdownToBlocks(post.bodyMarkdown, post.title);
    const readTime = computeReadTime(post.bodyMarkdown);

    const image = await imagePromise;
    console.log(
      image
        ? `[API POST /api/approve] Featured image ready (${image.provider}, ${(image.bytes / 1024).toFixed(0)}KB): ${image.url}`
        : '[API POST /api/approve] No featured image — saving the draft without one.'
    );

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
      type: post.type,
      image: image ? image.url : null,
      // Display date. Previously left empty and typed by hand for every post,
      // which blocked the dashboard's Publish button on every generated draft
      // (it requires this field) — and, worse, did NOT block Discord's publish
      // path, which validates nothing. Generating it closes that gap and stops
      // the format drifting between posts. Still editable in the dashboard.
      post_date: formatPostDate()
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

    // The image URL is returned so the dashboard can show the hero immediately
    // on the draft it opens, without a second round-trip.
    res.json({ success: true, draftId: data.id, slug: data.slug, image: image ? image.url : null });
  } catch (error) {
    // A draft rejected by the writer's content gate never reached Supabase.
    // Report it distinctly from a genuine save failure so the cause is obvious
    // in the logs instead of being buried under "Failed to save draft".
    if (error instanceof PostValidationError) {
      console.error('[API POST /api/approve] Draft REJECTED by the content gate — nothing was saved. Reasons:', error.reasons);
      // Raise a visible alert. A console-only rejection is invisible on
      // serverless, which is why the original incident was found by reading the
      // live site rather than from a notification.
      await notifyFailure(
        'Draft generation',
        `Topic: ${req.body && req.body.topic && req.body.topic.title ? req.body.topic.title : 'unknown'}`,
        error.reasons
      );
      return res.status(422).json({
        error: 'The generated draft failed the content quality gate and was not saved',
        details: error.message,
        reasons: error.reasons
      });
    }
    console.error('[API POST /api/approve] Error generating/logging post:', error);
    res.status(500).json({ error: 'Failed to save draft', details: error.message });
  }
});

// Regenerates the featured image for an existing DRAFT and persists it.
// Backs the dashboard's "Generate with AI" button, and shares
// regenerateImageForDraft() with the Discord button so the draft-only rule
// cannot drift between the two entry points.
//
// Unlike the draft-save path this uses the THROWING variant: the user asked for
// an image explicitly, so a failure must be reported rather than silently
// swallowed.
app.post('/api/image', async (req, res) => {
  try {
    const { draftId } = req.body || {};
    if (!draftId) {
      return res.status(400).json({ error: 'Missing draftId' });
    }

    console.log(`\n[API POST /api/image] Regenerating featured image for draft ${draftId}...`);
    const result = await regenerateImageForDraft(draftId);
    console.log(`[API POST /api/image] New image: ${result.url}`);

    return res.json({ success: true, image: result.url, scene: result.scene });
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      // 422: the request was well-formed but could not be fulfilled (not a
      // draft, draft deleted, provider refused). Distinct from a server fault.
      console.warn(`[API POST /api/image] Rejected: ${error.message}`);
      return res.status(422).json({ error: error.message });
    }
    console.error('[API POST /api/image] Unexpected failure:', error);
    return res.status(500).json({ error: 'Failed to regenerate the image', details: error.message });
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
