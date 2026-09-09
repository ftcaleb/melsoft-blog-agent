import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateCandidates, refreshResearchCache } from './src/research.js';
import { selectTopics, selectTopicsForPillar, selectTopicsForDigital, pillarForDate } from './src/select.js';
import { writePost, PostValidationError, formatPostDate } from './src/writer.js';
import { supabase } from './src/supabaseClient.js';
import { markdownToBlocks, computeReadTime } from './src/markdownToBlocks.js';
import { registerDiscordRoutes, buildTopicButtons } from './src/discordInteractions.js';
import { notifyDiscord, notifyFailure } from './src/notify.js';
import { generateFeaturedImageSafe, regenerateImageForDraft, ImageGenerationError } from './src/imageGen.js';
import { getProfile } from './src/profiles.js';

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

// Scheduled research-cache refresh (Vercel cron). Authenticated by CRON_SECRET,
// which Vercel injects as "Authorization: Bearer <CRON_SECRET>" on cron
// requests — NOT the Supabase session — so it is registered BEFORE the
// requireAuth gate below. It regenerates the recent-topics research, stores it
// in Supabase (nothing is written to the posts table), and pings Discord.
//
// One route serves BOTH content lines: Digital gets its own vercel.json cron
// entry pointing here with ?profile=digital on its own schedule, independent
// of Academy's weekday rotation. Omitting the param (Academy's existing cron
// entry) behaves exactly as before this feature existed.
app.get('/api/cron/refresh-topics', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const profile = getProfile(req.query.profile);
  try {
    console.log(`[cron] Refreshing research cache (${profile.key})...`);
    const candidates = await refreshResearchCache(profile);
    console.log(`[cron] Research cache refreshed (${profile.key}): ${candidates.length} candidates.`);

    // Notify Discord with the SAME topics the dashboard/Discord /topics would
    // show, not the raw candidate list. Each gets a "Generate #N" button whose
    // numbering matches the list. Non-fatal: any failure here is logged, and
    // the cache refresh above still counts as a success.
    const appUrl = process.env.APP_URL || 'https://melsoft-blog.vercel.app';

    let selected = [];
    let dayName, pillarLabel, targetPillar; // Academy-only labelling, used below

    if (profile.key === 'digital') {
      // No weekday pillar rotation for Digital — it's news/commentary, so
      // "freshest across both categories" is the whole selection rule.
      if (candidates.length) {
        try {
          const pool = await generateCandidates({ forceFresh: false, profile });
          selected = selectTopicsForDigital(pool, 3);
        } catch (selErr) {
          console.warn('[cron] Could not select Digital topics:', selErr.message);
        }
      }
      console.log(`[cron] Digital run; offering ${selected.length} topic(s).`);
    } else {
      // One post a day, 5 a week: the weekday decides the pillar (3 skills + 2
      // tech per week). Off-schedule manual runs (weekends) fall back to skills,
      // the majority pillar, so a manual trigger still produces useful options.
      const now = new Date();
      const scheduled = pillarForDate(now);
      targetPillar = scheduled || 'skills';
      dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getUTCDay()];
      pillarLabel = targetPillar === 'skills' ? 'SKILLS DEVELOPMENT' : 'TECH';

      if (candidates.length) {
        try {
          // Re-read through generateCandidates so evergreen topics and the
          // already-covered dedup are applied, exactly like GET /api/topics.
          const pool = await generateCandidates({ forceFresh: false, profile });
          selected = selectTopicsForPillar(pool, targetPillar, 3);
        } catch (selErr) {
          console.warn(`[cron] Could not select ${targetPillar} topics:`, selErr.message);
        }
      }
      console.log(`[cron] ${dayName} → ${targetPillar} day; offering ${selected.length} topic(s).`);
    }

    let message;
    let buttons;
    if (profile.key === 'digital') {
      if (selected.length) {
        const list = selected
          .map((t, i) => `${i + 1}. \`[${String(t.pillar || '?').toUpperCase()}]\` ${t.title}`)
          .join('\n');
        buttons = buildTopicButtons(selected, profile.key);
        message =
          `🔔 **Melsoft Digital — new topics**\n\n` +
          `👉 **Open the blog agent:** ${appUrl}\n\n${list}\n\n` +
          `🖱️ Tap a button below to draft that topic here in Discord.`;
      } else {
        message =
          `🔔 **Melsoft Digital — new topics**\n\n` +
          `Topic research ran but no topics were available today.\n\n` +
          `👉 **Open the blog agent:** ${appUrl}`;
      }
    } else if (selected.length) {
      const list = selected
        .map((t, i) => `${i + 1}. \`[${String(t.type || '?').toUpperCase()}]\` ${t.title}`)
        .join('\n');
      buttons = buildTopicButtons(selected, profile.key);
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

    return res.json({ ok: true, profile: profile.key, refreshedAt: new Date().toISOString(), count: candidates.length });
  } catch (err) {
    console.error('[cron] Refresh failed:', err);
    // The cron calls refreshResearchCache() directly, so a failure here bypasses
    // the stale-cache fallback (and its alert) in getRecentCandidatesCached().
    // Without this, an unattended cron failure would be a silent 500 — exactly
    // the blind spot that let the original incident reach the live site.
    await notifyFailure(
      `Scheduled topic research (${profile.label})`,
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
// same result. Keyed per content line — an Academy request in flight must
// never hand its result to a concurrent Digital request.
const topicsInFlight = { academy: null, digital: null };

// API endpoint to retrieve the selected blog topic candidates.
// Pass ?fresh=true to bypass the 24h research cache and force live regeneration.
// Pass ?profile=digital for Melsoft Digital's line; omit for Academy (default,
// unchanged from before this line existed).
app.get('/api/topics', async (req, res) => {
  let profile = getProfile('academy');
  try {
    const forceFresh = req.query.fresh === 'true';
    profile = getProfile(req.query.profile);

    if (topicsInFlight[profile.key]) {
      console.log(`[API GET /api/topics] Request already in flight (${profile.key}) — coalescing (no extra API call).`);
      const result = await topicsInFlight[profile.key];
      return res.json(result);
    }

    // Optional ?pillar=tech|skills targets a single pillar (the daily plan:
    // 3 skills + 2 tech per week). Pass ?pillar=today to follow the weekday
    // schedule. Omit it for the original mixed 2 tech + 1 skills set.
    // Academy-only — Digital has no weekday pillar rotation.
    const pillarParam = String(req.query.pillar || '').toLowerCase();
    const targetPillar = profile.key === 'academy' && (
      pillarParam === 'today' ? (pillarForDate(new Date()) || 'skills')
      : (pillarParam === 'tech' || pillarParam === 'skills') ? pillarParam
      : null
    );

    topicsInFlight[profile.key] = (async () => {
      console.log(`[API GET /api/topics] (${profile.key}) Generating candidate topics${forceFresh ? ' (forceFresh — bypassing cache)' : ''}...`);
      const allCandidates = await generateCandidates({ forceFresh, profile });
      console.log(`[API GET /api/topics] Total candidates generated: ${allCandidates.length}`);

      console.log(`[API GET /api/topics] Selecting topics${targetPillar ? ` (${targetPillar} only)` : ''}...`);
      const selectedTopics =
        profile.key === 'digital' ? selectTopicsForDigital(allCandidates, 3)
        : targetPillar ? selectTopicsForPillar(allCandidates, targetPillar, 3)
        : selectTopics(allCandidates);

      console.log('[API GET /api/topics] Successfully selected topics:');
      selectedTopics.forEach((t, i) => {
        console.log(`  ${i + 1}. [${t.pillar.toUpperCase()} | ${t.type.toUpperCase()}] ${t.title}`);
      });

      return { topics: selectedTopics };
    })();

    const result = await topicsInFlight[profile.key];
    res.json(result);
  } catch (error) {
    console.error('[API GET /api/topics] Error generating/selecting topics:', error);
    res.status(500).json({ error: 'Failed to generate topics', details: error.message });
  } finally {
    topicsInFlight[profile.key] = null;
  }
});

// API endpoint to approve a selected topic and write the full blog post
app.post('/api/approve', async (req, res) => {
  try {
    const { topic, profile: profileKey, line } = req.body;
    if (!topic || !topic.title) {
      return res.status(400).json({ error: 'Missing or invalid topic parameter' });
    }
    // Defaults to Academy — every pre-existing caller (the dashboard) sends
    // neither field, so behaviour is unchanged.
    const profile = getProfile(profileKey || line);

    console.log(`\n[API POST /api/approve] (${profile.key}) Writing post for: "${topic.title}"...`);

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
    const imagePromise = generateFeaturedImageSafe(topic, profile);

    const post = await writePost(topic, profile);

    console.log(`[API POST /api/approve] Converting markdown to blocks and computing read time...`);
    const body = markdownToBlocks(post.bodyMarkdown, post.title);
    const readTime = computeReadTime(post.bodyMarkdown);

    const image = await imagePromise;
    console.log(
      image
        ? `[API POST /api/approve] Featured image ready (${image.provider}, ${(image.bytes / 1024).toFixed(0)}KB): ${image.url}`
        : '[API POST /api/approve] No featured image — saving the draft without one.'
    );

    // Shared fields across both tables. `posts` (Academy) and `blog_posts`
    // (Digital) diverge from here — see the matching comment in
    // discordInteractions.js's runGenerate(), which this mirrors exactly.
    const postData = {
      status: 'draft',
      slug: post.slug,
      title: post.title,
      excerpt: post.metaDescription,
      body: body,
      read_time: readTime,
      raw_markdown: post.bodyMarkdown,
      source_topic: post.sourceTopic,
      image: image ? image.url : null,
      // Display date. Previously left empty and typed by hand for every post,
      // which blocked the dashboard's Publish button on every generated draft
      // (it requires this field) — and, worse, did NOT block Discord's publish
      // path, which validates nothing. Generating it closes that gap and stops
      // the format drifting between posts. Still editable in the dashboard.
      post_date: formatPostDate()
    };

    if (profile.key === 'digital') {
      postData.category = post.pillar;
      postData.tint = profile.categoryTint[post.pillar] || null;
      postData.author = profile.author;
    } else {
      postData.pillar = post.pillar;
      postData.type = post.type;
    }

    console.log(`[API POST /api/approve] Inserting draft post into Supabase (${profile.table})...`);
    let { data, error } = await supabase
      .from(profile.table)
      .insert([postData])
      .select()
      .single();

    if (error) {
      // Postgres unique violation error code is 23505
      if (error.code === '23505') {
        console.log(`[API POST /api/approve] Duplicate slug detected: "${postData.slug}". Retrying insertion with unique suffix...`);
        postData.slug = post.slug + '-' + Date.now().toString(36).slice(-4);

        const retryResult = await supabase
          .from(profile.table)
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
    // 6/7). Academy-only — see the matching comment in discordInteractions.js.
    // Done as a separate best-effort update so a missing `cluster` column
    // (before the one-time ALTER TABLE is run) only warns — it never fails the
    // draft save. Once the column exists this populates automatically.
    if (profile.key === 'academy' && post.cluster) {
      const { error: clusterErr } = await supabase
        .from(profile.table)
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
