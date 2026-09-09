// Discord Interactions endpoint (slash commands + message-component buttons).
//
// This is ADDITIVE to the existing app: it registers a single route,
// POST /api/discord/interactions, and does NOT touch the Supabase auth
// middleware that guards the dashboard's HTTP /api routes. Discord requests
// are authenticated by Ed25519 signature verification (verifyKeyMiddleware),
// and a separate allow-list (DISCORD_ALLOWED_USER_IDS) gates the two commands
// that spend money or change published state (generate/publish).
//
// RAW BODY: verifyKeyMiddleware must receive the untouched raw request body to
// verify the signature. server.js therefore registers this route BEFORE the
// global express.json() parser — see registerDiscordRoutes() usage there.
import {
  verifyKeyMiddleware,
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
} from 'discord-interactions';
import { waitUntil } from '@vercel/functions';

import { generateCandidates } from './research.js';
import { selectTopics, selectTopicsForDigital } from './select.js';
import { writePost, formatPostDate } from './writer.js';
import { supabase } from './supabaseClient.js';
import { markdownToBlocks, computeReadTime } from './markdownToBlocks.js';
import { generateFeaturedImageSafe, regenerateImageForDraft } from './imageGen.js';
import { PROFILES, getProfile } from './profiles.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Splits a button/command payload into its content-line and the underlying
 * reference, e.g. "digital:id:<uuid>" -> { profile: digital, ref: "id:<uuid>" }.
 *
 * Backward compatible by construction: a payload with NO recognised line
 * prefix (every button that existed before this feature — "id:<uuid>",
 * "h:<hash>", a raw slug/title) falls through to Academy with the payload
 * untouched, so draft/publish buttons already posted in Discord before this
 * deploy keep working exactly as they did.
 *
 * @param {string} payload
 * @returns {{ profile: import('./profiles.js').SiteProfile, ref: string }}
 */
function parseLinePayload(payload) {
  const raw = String(payload || '');
  const sep = raw.indexOf(':');
  const firstSeg = sep === -1 ? raw : raw.slice(0, sep);
  if (PROFILES[firstSeg]) {
    return { profile: PROFILES[firstSeg], ref: raw.slice(sep + 1) };
  }
  return { profile: PROFILES.academy, ref: raw };
}

// ---------------------------------------------------------------------------
// Small helpers (shared by slash-command AND button handlers so the two never
// duplicate business logic).
// ---------------------------------------------------------------------------

function appUrl() {
  return process.env.APP_URL || 'https://melsoft-blog.vercel.app';
}

// The invoking Discord user id — from member.user in a guild, or user in a DM.
function getInvokerId(interaction) {
  return (
    (interaction.member && interaction.member.user && interaction.member.user.id) ||
    (interaction.user && interaction.user.id) ||
    null
  );
}

// Allow-list for money-spending / state-changing actions. Read-only /topics is
// intentionally exempt. Parsed fresh each call so env changes take effect
// without a redeploy of this module's import graph.
function isAuthorized(userId) {
  const raw = process.env.DISCORD_ALLOWED_USER_IDS || '';
  const allowed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // If no allow-list is configured, fail closed: no one may generate/publish.
  if (allowed.length === 0) return false;
  return !!userId && allowed.includes(userId);
}

// Reads the current trending topics the SAME way GET /api/topics does: from the
// Supabase-backed research cache (no billed re-research) unless forceFresh.
// Academy keeps its fixed 2-tech/1-skills selection; Digital has no fixed mix.
async function getSelectedTopics({ forceFresh = false, profile = getProfile('academy') } = {}) {
  const candidates = await generateCandidates({ forceFresh, profile });
  return profile.key === 'digital' ? selectTopicsForDigital(candidates) : selectTopics(candidates);
}

// Short, stable reference for a topic, used inside a button's custom_id.
//
// Discord caps custom_id at 100 chars, and generated titles routinely run
// 90–120, so the full title cannot be embedded (it silently dropped most
// buttons). A hash keeps the id tiny (`generate:h:3f9a2c81`) AND — unlike an
// index — can never resolve to a *different* topic: either the hash matches a
// current candidate (exactly the topic the message showed) or it matches
// nothing (the button has expired). FNV-1a over a normalised title.
export function topicHash(title) {
  const s = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Discord message-component constants (see discord.com/developers component docs).
const DISCORD_ACTION_ROW = 1; // component type: a row that holds up to 5 buttons
const DISCORD_BUTTON = 2; // component type: a button
const DISCORD_BUTTON_PRIMARY = 1; // button style: filled/primary
const DISCORD_CUSTOM_ID_MAX = 100; // hard limit on a component custom_id
const DISCORD_BUTTONS_PER_ROW = 5; // max buttons in one action row
const DISCORD_MAX_BUTTON_ROWS = 5; // max action rows in one message

// Builds "Generate #N" button rows for the given topics, matching the numbering
// used in the message's text list. Each button's custom_id is
// `generate:<line>:h:<hash>` — a SHORT reference the interactions handler
// resolves back to the exact topic before drafting it.
//
// Why a hash and not the title: Discord caps custom_id at 100 chars and titles
// routinely run 90–120, so embedding the full title silently dropped almost
// every button (only a title <= 91 chars survived). A hash is always ~19 chars,
// so every button renders — and unlike an index it can never resolve to a
// different topic if the topic list is refreshed before someone clicks.
//
// `line` is embedded so the click routes to the right content line/table (see
// parseLinePayload) — always encoded explicitly here (even for 'academy')
// rather than relying on that function's no-prefix default, so every NEWLY
// posted button is unambiguous. Lives here (not server.js) so both the cron
// notification and the on-demand /academy + /digital commands share it.
export function buildTopicButtons(candidates, line = 'academy') {
  const rows = [];
  let current = null;
  const skipped = [];

  for (let i = 0; i < candidates.length; i++) {
    const title = String(candidates[i] && candidates[i].title || '').trim();
    if (!title) continue;

    const customId = `generate:${line}:h:${topicHash(title)}`;
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

// Builds the on-demand "pick a topic" message for a content line — the same
// numbered list + Generate buttons the scheduled cron posts, but triggered by
// a person typing /academy or /digital, so no @mention (they're already
// looking) and no weekday/pillar framing (that's the cron's daily-plan
// concept, not a manual pull).
function formatPickTopicMessage(topics, profile) {
  const appUrl = process.env.APP_URL || 'https://melsoft-blog.vercel.app';
  const heading = `🔔 **Melsoft ${profile.label} — pick a topic**`;
  if (!Array.isArray(topics) || topics.length === 0) {
    return `${heading}\n\nNo topics are available right now. Try again after the next scheduled research run.\n\n👉 **Open the blog agent:** ${appUrl}`;
  }
  const list = topics
    .map((t, i) => `${i + 1}. \`[${String(t.pillar || '?').toUpperCase()}]\` ${t.title}`)
    .join('\n');
  return (
    `${heading}\n\n👉 **Open the blog agent:** ${appUrl}\n\n${list}\n\n` +
    `🖱️ Tap a button below to draft that topic here in Discord.`
  );
}

// Resolves a generate-button payload into something runGenerate can use.
//   "h:<hash>" -> the matching candidate object (carrying pillar/pitch/cluster),
//                 or null when nothing matches (topics rotated / already written).
//   anything else -> treated as a literal title, preserving older buttons that
//                 still carry the full title in their custom_id.
async function resolveTopicRef(payload, profile = getProfile('academy')) {
  if (!/^h:[0-9a-f]{8}$/i.test(payload)) return payload; // legacy full-title button
  const hash = payload.slice(2).toLowerCase();
  const candidates = await generateCandidates({ forceFresh: false, profile });
  return candidates.find((c) => topicHash(c.title) === hash) || null;
}

function formatTopicsMessage(topics, profile = getProfile('academy')) {
  const heading = profile.key === 'academy' ? 'Current trending topics' : `Current trending topics (${profile.label})`;
  if (!Array.isArray(topics) || topics.length === 0) {
    return 'No trending topics are cached right now. Try again after the next scheduled research run.';
  }
  const lines = topics.map((t, i) => {
    const tag = `[${String(t.pillar || '?').toUpperCase()} | ${String(t.type || '?').toUpperCase()}]`;
    const pitch = t.pitch ? `\n   ${t.pitch}` : '';
    return `**${i + 1}.** ${tag} ${t.title}${pitch}`;
  });
  return `**${heading}**\n\n${lines.join('\n\n')}\n\nUse \`/generate <topic>\` to draft one.`;
}

// Writes a draft the SAME way POST /api/approve does: writePost() -> convert
// markdown to blocks + read time -> insert into Supabase (with the 23505
// duplicate-slug retry). Returns { draftId, slug, title, excerpt }.
// Does NOT publish. `topicInput` may be a full candidate object or a bare title.
async function runGenerate(topicInput, profile = getProfile('academy')) {
  // Accept either a candidate object or a plain topic title string.
  let topic =
    typeof topicInput === 'string'
      ? { title: topicInput.trim() }
      : { ...topicInput };

  if (!topic.title) {
    throw new Error('A topic title is required.');
  }

  // Enrich a bare title by matching it against the current cached candidates,
  // so /generate on a trending topic reuses that candidate's pillar/type/pitch.
  // Cache-served (no billed research); best-effort — falls back to a minimal
  // ad-hoc topic if there's no match or the lookup fails.
  if (!topic.pillar || !topic.pitch) {
    try {
      const candidates = await generateCandidates({ forceFresh: false, profile });
      const needle = topic.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = candidates.find((c) => {
        const hay = String(c.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return hay && (hay === needle || hay.includes(needle) || needle.includes(hay));
      });
      if (match) topic = { ...match, ...topic, title: topic.title };
    } catch (lookupErr) {
      console.warn('[discord] Topic enrichment lookup failed (using ad-hoc topic):', lookupErr.message);
    }
  }

  // Minimal defaults so writePost + the insert always have sane values.
  topic.pitch = topic.pitch || `Ad-hoc topic requested via Discord: ${topic.title}`;
  topic.pillar = topic.pillar || profile.categories[0];
  topic.type = topic.type || 'evergreen';
  topic.sourceNotes = topic.sourceNotes || 'Requested via Discord /generate';

  // Featured image generation runs CONCURRENTLY with the article, mirroring
  // /api/approve. Serially the two would exceed Vercel's 60s maxDuration and the
  // interaction would time out with nothing to show. The image prompt derives
  // from the TOPIC, not the finished article, so there is nothing to wait for.
  //
  // Safe variant: a failure here leaves the draft imageless rather than losing
  // it. The Discord message then simply carries no preview.
  const imagePromise = generateFeaturedImageSafe(topic, profile);

  const post = await writePost(topic, profile);
  const body = markdownToBlocks(post.bodyMarkdown, post.title);
  const readTime = computeReadTime(post.bodyMarkdown);

  const image = await imagePromise;

  // Shared fields across both tables. `posts` (Academy) and `blog_posts`
  // (Digital) diverge from here: Academy tracks pillar/type, Digital tracks
  // category/tint/author instead — see the create-table SQL in the project plan.
  const postData = {
    status: 'draft',
    slug: post.slug,
    title: post.title,
    excerpt: post.metaDescription,
    body,
    read_time: readTime,
    raw_markdown: post.bodyMarkdown,
    source_topic: post.sourceTopic,
    // Display date — see the matching comment in server.js /api/approve. This
    // path matters most: runPublish() performs no field validation at all, so
    // without this a Discord-published post went live with no date shown.
    post_date: formatPostDate(),
    image: image ? image.url : null,
  };

  if (profile.key === 'digital') {
    postData.category = post.pillar;
    postData.tint = profile.categoryTint[post.pillar] || null;
    postData.author = profile.author;
  } else {
    postData.pillar = post.pillar;
    postData.type = post.type;
  }

  let { data, error } = await supabase
    .from(profile.table)
    .insert([postData])
    .select()
    .single();

  if (error) {
    // 23505 = Postgres unique violation (duplicate slug). Retry once with a
    // short unique suffix — identical to POST /api/approve.
    if (error.code === '23505') {
      postData.slug = post.slug + '-' + Date.now().toString(36).slice(-4);
      const retry = await supabase.from(profile.table).insert([postData]).select().single();
      if (retry.error) throw new Error(retry.error.message);
      data = retry.data;
    } else {
      throw new Error(error.message);
    }
  }

  // Persist the topic cluster for per-cluster performance reporting (Deliverable
  // 6/7). Academy-only concept — Digital has no `cluster` column and
  // classifyCluster() never resolves one for it anyway. Best-effort separate
  // update so a missing `cluster` column only warns — it never fails the draft
  // save.
  if (profile.key === 'academy' && post.cluster) {
    const { error: clusterErr } = await supabase
      .from(profile.table)
      .update({ cluster: post.cluster })
      .eq('id', data.id);
    if (clusterErr) {
      console.warn(`[discord] Could not persist cluster "${post.cluster}" (is the 'cluster' column added?): ${clusterErr.message}`);
    }
  }

  return {
    draftId: data.id,
    slug: data.slug,
    title: data.title,
    excerpt: post.metaDescription,
    image: image ? image.url : null,
  };
}

// Flips a draft to published the SAME way the dashboard publish action does
// (status='published' + published_at timestamp). Confirms the slug exists as a
// draft first; returns { ok:false, message } instead of throwing when it does
// not, so the caller can reply cleanly.
async function runPublish(ref, profile = getProfile('academy')) {
  const clean = String(ref || '').trim();
  if (!clean) return { ok: false, message: 'No post reference provided.' };

  // Two accepted forms:
  //   "id:<uuid>"  the Publish BUTTON — always 39 chars, so `publish:id:<uuid>`
  //                is 47 and can never breach Discord's 100-char custom_id cap.
  //   "<slug>"     the `/publish <slug>` slash command, and any button from
  //                before this change that still carries a raw slug.
  //
  // The slug form was the only one originally, and it silently cost 7 of 18
  // real posts their Publish button: titles here routinely produce slugs of
  // 90-106 chars, and `publish:` + those exceeds the cap. The button was then
  // dropped rather than rendered, with no visible explanation.
  const byId = clean.startsWith('id:');
  const value = byId ? clean.slice(3) : clean;

  const base = supabase.from(profile.table).select('id, slug, status, title');
  const { data: existing, error: findErr } = byId
    ? await base.eq('id', value).maybeSingle()
    : await base.eq('slug', value).maybeSingle();

  if (findErr) return { ok: false, message: `Lookup failed: ${findErr.message}` };
  if (!existing) {
    return {
      ok: false,
      message: byId
        ? 'That draft no longer exists — it may have been deleted.'
        : `No post found with slug \`${value}\`.`,
    };
  }
  if (existing.status === 'published') {
    return {
      ok: false,
      // Always build the live URL from the ROW's slug, never from the incoming
      // reference — under the `id:<uuid>` form the reference is not a slug.
      message: `ℹ️ Already published: ${existing.title}\n🔗 ${profile.liveBase}/${existing.slug}`,
    };
  }

  const { error: updErr } = await supabase
    .from(profile.table)
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', existing.id);

  if (updErr) return { ok: false, message: `Publish failed: ${updErr.message}` };
  return {
    ok: true,
    message: `✅ Published: ${existing.title}\n🔗 ${profile.liveBase}/${existing.slug}`,
    title: existing.title,
  };
}

// Friendly, on-brand wrapper for error replies. Non-technical people in the
// channel see the bot, not the code — a bare stack/JSON blob reads as "the
// bot is broken" even for a normal, recoverable hiccup. `intro` carries the
// human tone; the real error still rides along in a code block underneath,
// so nothing is ever hidden from whoever needs to actually debug it.
function friendlyError(intro, err) {
  const detail = (err && err.message) ? err.message : String(err);
  return `${intro}\n\`\`\`${detail.slice(0, 900)}\`\`\``;
}

// PATCHes the deferred interaction's original response with the final message.
// Uses node's built-in fetch, same one-way pattern as notifyDiscord() in
// server.js. The interaction token authorizes this call, so no bot token is
// needed and nothing secret is logged.
async function editOriginalResponse(interaction, content, components, embeds) {
  const applicationId = interaction.application_id || process.env.DISCORD_APPLICATION_ID;
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${interaction.token}/messages/@original`;
  const payload = { content: String(content).slice(0, 1990) };
  // Interaction followups are application-owned, so message components (buttons)
  // render natively — no ?with_components=true needed. Only attach when provided
  // so existing callers (publish/topics) are unaffected.
  if (Array.isArray(components) && components.length > 0) {
    payload.components = components;
  }
  // Embeds carry the featured-image preview. Attached only when present, so
  // every pre-existing caller sends a byte-identical payload to before.
  if (Array.isArray(embeds) && embeds.length > 0) {
    payload.embeds = embeds;
  }
  try {
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) console.warn(`[discord] Followup edit responded ${resp.status}`);
  } catch (err) {
    console.warn('[discord] Followup edit failed:', err.message);
  }
}

// Ensures the deferred work (Claude + web search, then the followup PATCH)
// actually finishes on Vercel serverless, where the function can be frozen the
// moment the initial DEFERRED response is sent. waitUntil() keeps the invocation
// alive until the promise settles (bounded by the function's maxDuration). On
// Render/local the persistent process runs the promise anyway, so a waitUntil
// failure there is caught and ignored.
function keepAlive(promise) {
  const p = Promise.resolve(promise).catch((err) =>
    console.error('[discord] Deferred work failed:', err.message)
  );
  try {
    waitUntil(p);
  } catch {
    /* not running on Vercel — the persistent process completes the promise */
  }
}

// Runs generate/publish work after a deferred ack and edits the followup with
// the result. Shared by BOTH slash commands and button clicks. Never throws to
// the request handler — failures become a followup message.
// Melsoft brand plum (#720075) as the embed's accent stripe.
const EMBED_COLOUR = 0x720075;

/**
 * Builds the draft-preview embed. When a featured image exists it renders full
 * width above the buttons, so the image can be REVIEWED before publishing —
 * the only real quality control on an automated image, since nothing downstream
 * inspects what the model actually drew.
 *
 * Returns undefined when there is no image, leaving the plain-text message
 * exactly as it was before images existed.
 *
 * @param {string} title Post title
 * @param {string} excerpt Meta description
 * @param {string|null} image Public image URL
 * @returns {object[]|undefined}
 */
export function buildDraftEmbeds(title, excerpt, image) {
  if (!image) return undefined;
  return [
    {
      title: String(title || 'Untitled draft').slice(0, 256),
      description: String(excerpt || '').slice(0, 400),
      color: EMBED_COLOUR,
      image: { url: image },
      footer: { text: 'Review the image before publishing' },
    },
  ];
}

/**
 * Buttons shown under a draft: Publish, plus Regenerate image when there is an
 * image to replace.
 *
 * Both reference the draft by UUID, prefixed with the content line so the
 * click routes back to the right table (`publish:digital:id:<uuid>` = 55
 * chars, `regenimg:digital:id:<uuid>` = 56 — still well inside Discord's
 * 100-char custom_id cap, which real Academy titles already brushed against
 * before draft-id references replaced raw slugs).
 *
 * @param {string} draftId Post UUID
 * @param {string|null} image Current image URL, if any
 * @param {import('./profiles.js').SiteProfile} [profile] Defaults to Academy, matching every pre-existing caller
 * @returns {object[]} Action rows
 */
export function buildDraftComponents(draftId, image, profile = getProfile('academy')) {
  const buttons = [
    {
      type: 2, // BUTTON
      style: 3, // SUCCESS (green) — distinct from the blue Generate buttons
      label: 'Publish',
      custom_id: `publish:${profile.key}:id:${draftId}`,
    },
  ];

  // Only offered when there is an image to replace. With no image the useful
  // action is a manual upload in the dashboard, not another roll of the dice.
  if (image) {
    buttons.push({
      type: 2,
      style: 2, // SECONDARY (grey) — deliberately less prominent than Publish
      label: 'Regenerate image',
      custom_id: `regenimg:${profile.key}:id:${draftId}`,
    });
  }

  return [{ type: 1, components: buttons }]; // ACTION_ROW
}

async function handleGenerateDeferred(interaction, topicInput, profile = getProfile('academy')) {
  try {
    const { draftId, slug, title, excerpt, image } = await runGenerate(topicInput, profile);
    const preview = (excerpt || '').slice(0, 300);
    // With an embed the title and excerpt are shown there, so the message body
    // is kept to the operational detail rather than repeating itself.
    const content = image
      ? `Draft ready — review the image below.\nSlug: \`${slug}\`\n${appUrl()}/dashboard.html`
      : `Draft ready: **${title}**\n` +
        (preview ? `> ${preview}\n` : '') +
        `Slug: \`${slug}\`\n` +
        `⚠️ No featured image was generated — the blog card will show a plain colour block.\n` +
        `Review the full draft in the dashboard: ${appUrl()}/dashboard.html`;

    // One-click Publish button (green / style 3) reusing the existing
    // `publish:` MESSAGE_COMPONENT handler — no new routing. Authorization is
    // enforced there (DISCORD_ALLOWED_USER_IDS); no extra confirmation step.
    //
    // Referenced by DRAFT ID, not slug. `publish:id:<uuid>` is always 47 chars,
    // where `publish:<slug>` ran 76-114 and breached Discord's 100-char cap on
    // 7 of 18 real posts — silently dropping the button on exactly the
    // long-titled posts, with nothing to explain why. The guard below is kept
    // as a backstop but can no longer fire.
    const components = buildDraftComponents(draftId, image, profile);

    await editOriginalResponse(interaction, content, components, buildDraftEmbeds(title, excerpt, image));
  } catch (err) {
    console.warn('[discord] Generate failed:', err.message);
    // After writer.js's own retries, an API-status error here means Anthropic
    // genuinely didn't come back — worth saying so explicitly rather than
    // leaving it to be inferred from the raw error text below.
    const apiFailure = err && (!err.status || err.status >= 500);
    const intro = apiFailure
      ? "😵‍💫 Well, this is awkward — Anthropic's API face-planted and stayed down even after a few retries. Probably just a hiccup on their end, try again in a few minutes."
      : "😬 Couldn't get that draft written.";
    await editOriginalResponse(interaction, friendlyError(intro, err));
  }
}

/**
 * Regenerates a draft's featured image and rebuilds the SAME message in place —
 * new embed, same buttons — so the reviewer keeps tapping until the image is
 * right, without the channel filling with near-duplicate drafts.
 *
 * Drafts only; regenerateImageForDraft() refuses published posts.
 */
async function handleRegenerateImageDeferred(interaction, ref, profile = getProfile('academy')) {
  const draftId = String(ref || '').replace(/^id:/, '').trim();
  try {
    const { url, title, slug, excerpt } = await regenerateImageForDraft(draftId, profile);
    const content =
      `Image regenerated — review it below.\nSlug: \`${slug}\`\n${appUrl()}/dashboard.html`;
    await editOriginalResponse(
      interaction,
      content,
      buildDraftComponents(draftId, url, profile),
      buildDraftEmbeds(title, excerpt, url)
    );
  } catch (err) {
    console.warn('[discord] Image regeneration failed:', err.message);
    await editOriginalResponse(interaction, friendlyError('🎨 The image regen didn’t stick.', err));
  }
}

async function handlePublishDeferred(interaction, ref, profile = getProfile('academy')) {
  try {
    const result = await runPublish(ref, profile);
    await editOriginalResponse(interaction, result.message);
  } catch (err) {
    console.warn('[discord] Publish failed:', err.message);
    await editOriginalResponse(interaction, friendlyError('🚧 Publishing hit a snag.', err));
  }
}

// Button path for generate: resolve the custom_id payload to a topic first, so a
// stale button reports honestly instead of silently drafting the wrong topic.
// The payload carries the content line (see parseLinePayload) so the draft
// lands in the right table.
async function handleGenerateFromRef(interaction, payload) {
  const { profile, ref } = parseLinePayload(payload);
  let topic;
  try {
    topic = await resolveTopicRef(ref, profile);
  } catch (err) {
    console.warn('[discord] Topic reference lookup failed:', err.message);
    await editOriginalResponse(interaction, friendlyError('🔍 Couldn’t track down that topic.', err));
    return;
  }
  if (topic === null) {
    await editOriginalResponse(
      interaction,
      'Those topics have since been refreshed, so this button has expired. Run `/topics` for the current list.'
    );
    return;
  }
  await handleGenerateDeferred(interaction, topic, profile);
}

async function handleTopicsDeferred(interaction, profile = getProfile('academy')) {
  try {
    const topics = await getSelectedTopics({ forceFresh: false, profile });
    await editOriginalResponse(interaction, formatTopicsMessage(topics, profile));
  } catch (err) {
    console.warn('[discord] Topics failed:', err.message);
    await editOriginalResponse(interaction, friendlyError('📋 Couldn’t pull up the topics list.', err));
  }
}

// /academy and /digital: post a fresh pick-a-topic message with Generate
// buttons for that line, on demand. Buttons are only attached when there is
// something to click — an empty list gets the plain "nothing available" text.
async function handlePickTopicDeferred(interaction, profile) {
  try {
    const topics = await getSelectedTopics({ forceFresh: false, profile });
    await editOriginalResponse(
      interaction,
      formatPickTopicMessage(topics, profile),
      topics.length ? buildTopicButtons(topics, profile.key) : undefined
    );
  } catch (err) {
    console.warn(`[discord] /${profile.key} failed:`, err.message);
    await editOriginalResponse(interaction, friendlyError('📋 Couldn’t pull up the topic list.', err));
  }
}

// Immediate JSON responses -------------------------------------------------

function pong(res) {
  return res.json({ type: InteractionResponseType.PONG });
}

function ephemeral(res, content) {
  return res.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: InteractionResponseFlags.EPHEMERAL },
  });
}

// A deferred ack. Discord shows "thinking…"; we edit @original when work ends.
// `isEphemeral` must be decided here (Discord can't change it after the fact).
function defer(res, isEphemeral) {
  const data = isEphemeral ? { flags: InteractionResponseFlags.EPHEMERAL } : {};
  return res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  });
}

// Extracts a string option value from an APPLICATION_COMMAND interaction.
function getOption(interaction, name) {
  const opts = (interaction.data && interaction.data.options) || [];
  const found = opts.find((o) => o.name === name);
  return found ? found.value : undefined;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerDiscordRoutes(app) {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    // Register nothing rather than crash the whole server if the key is absent
    // (e.g. a local run without Discord configured). Existing routes are
    // unaffected.
    console.warn('[discord] DISCORD_PUBLIC_KEY is not set — /api/discord/interactions not registered.');
    return;
  }

  // verifyKeyMiddleware runs FIRST and rejects (401) anything whose Ed25519
  // signature does not verify, before any business logic. It also answers the
  // PING handshake itself. This must receive the raw body — hence this route is
  // registered before the global express.json() in server.js.
  app.post('/api/discord/interactions', verifyKeyMiddleware(publicKey), async (req, res) => {
    const interaction = req.body;

    try {
      // Defensive: verifyKeyMiddleware already answers PING, but handle it too.
      if (interaction.type === InteractionType.PING) {
        return pong(res);
      }

      // ---- Slash commands ------------------------------------------------
      if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const name = interaction.data && interaction.data.name;

        // Optional `line` option on /topics and /generate (Academy | Digital),
        // resolved via getProfile() which defaults to Academy when omitted —
        // so every pre-existing invocation with no `line` behaves unchanged.
        const line = getOption(interaction, 'line');
        const profile = getProfile(line);

        if (name === 'topics') {
          // Read-only: no allow-list required. Defer (a cache miss can call
          // Claude and exceed the 3s window), then edit with the result.
          defer(res, false);
          keepAlive(handleTopicsDeferred(interaction, profile));
          return;
        }

        // On-demand "pick a topic" for one line — the same numbered list +
        // Generate buttons the scheduled cron posts, without waiting for the
        // schedule. Read-only like /topics (cache-served, nothing billed
        // here); clicking a button still goes through the normal generate
        // allow-list gate.
        if (name === 'academy' || name === 'digital') {
          defer(res, false);
          keepAlive(handlePickTopicDeferred(interaction, getProfile(name)));
          return;
        }

        if (name === 'generate') {
          if (!isAuthorized(getInvokerId(interaction))) {
            return ephemeral(res, "You're not authorized to generate posts.");
          }
          const topic = getOption(interaction, 'topic');
          if (!topic) return ephemeral(res, 'Please provide a `topic`.');
          defer(res, false); // public: visible to the whole channel
          keepAlive(handleGenerateDeferred(interaction, topic, profile));
          return;
        }

        if (name === 'publish') {
          if (!isAuthorized(getInvokerId(interaction))) {
            return ephemeral(res, "You're not authorized to publish posts.");
          }
          const slug = getOption(interaction, 'slug');
          if (!slug) return ephemeral(res, 'Please provide a `slug`.');
          defer(res, false); // public: visible to the whole channel
          keepAlive(handlePublishDeferred(interaction, slug, profile));
          return;
        }

        return ephemeral(res, `Unknown command: ${name}`);
      }

      // ---- Message component (button) interactions -----------------------
      // Buttons must carry a custom_id of the form "generate:<topic>" or
      // "publish:<slug>" so a click reuses the exact same logic as the slash
      // commands (no duplicated business logic). Since the second Discord
      // integration was added, the payload after the action may ALSO carry a
      // leading content-line segment ("digital:id:<uuid>") — parseLinePayload()
      // strips and resolves that, falling back to Academy for any payload
      // that predates this (every button already posted in Discord).
      if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
        const customId = (interaction.data && interaction.data.custom_id) || '';
        const sep = customId.indexOf(':');
        const action = sep === -1 ? customId : customId.slice(0, sep);
        const payload = sep === -1 ? '' : customId.slice(sep + 1);

        if (action === 'generate') {
          if (!isAuthorized(getInvokerId(interaction))) {
            return ephemeral(res, "You're not authorized to generate posts.");
          }
          if (!payload) return ephemeral(res, 'This button is missing a topic.');
          defer(res, false); // public: visible to the whole channel
          keepAlive(handleGenerateFromRef(interaction, payload));
          return;
        }

        if (action === 'publish') {
          if (!isAuthorized(getInvokerId(interaction))) {
            return ephemeral(res, "You're not authorized to publish posts.");
          }
          if (!payload) return ephemeral(res, 'This button is missing a slug.');
          defer(res, false); // public: visible to the whole channel
          const { profile, ref } = parseLinePayload(payload);
          keepAlive(handlePublishDeferred(interaction, ref, profile));
          return;
        }

        // Regenerating spends money on a new image, so it sits behind the same
        // allow-list as generate/publish rather than being treated as read-only.
        if (action === 'regenimg') {
          if (!isAuthorized(getInvokerId(interaction))) {
            return ephemeral(res, "You're not authorized to regenerate images.");
          }
          if (!payload) return ephemeral(res, 'This button is missing a draft reference.');
          defer(res, false); // public: visible to the whole channel
          const { profile, ref } = parseLinePayload(payload);
          keepAlive(handleRegenerateImageDeferred(interaction, ref, profile));
          return;
        }

        return ephemeral(res, `Unknown button action: ${action}`);
      }

      // Any other interaction type: acknowledge without action.
      return ephemeral(res, 'Unsupported interaction type.');
    } catch (err) {
      console.error('[discord] Interaction handler error:', err.message);
      // If we haven't responded yet, send a minimal ephemeral error. If we
      // already deferred, the deferred handlers own their own error followups.
      if (!res.headersSent) {
        return ephemeral(res, friendlyError('🤖 Something went sideways handling that.', err));
      }
    }
  });

  console.log('[discord] Registered POST /api/discord/interactions');
}

export default registerDiscordRoutes;
