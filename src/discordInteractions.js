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
import { selectTopics } from './select.js';
import { writePost } from './writer.js';
import { supabase } from './supabaseClient.js';
import { markdownToBlocks, computeReadTime } from './markdownToBlocks.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Live post URL base on the Melsoft website (the same base the dashboard's
// "View live" button uses). A published post lives at `${LIVE_POST_BASE}/${slug}`.
const LIVE_POST_BASE = 'https://www.melsoftacademy.com/blog-preview';

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
async function getSelectedTopics({ forceFresh = false } = {}) {
  const candidates = await generateCandidates({ forceFresh });
  return selectTopics(candidates);
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

// Resolves a generate-button payload into something runGenerate can use.
//   "h:<hash>" -> the matching candidate object (carrying pillar/pitch/cluster),
//                 or null when nothing matches (topics rotated / already written).
//   anything else -> treated as a literal title, preserving older buttons that
//                 still carry the full title in their custom_id.
async function resolveTopicRef(payload) {
  if (!/^h:[0-9a-f]{8}$/i.test(payload)) return payload; // legacy full-title button
  const hash = payload.slice(2).toLowerCase();
  const candidates = await generateCandidates({ forceFresh: false });
  return candidates.find((c) => topicHash(c.title) === hash) || null;
}

function formatTopicsMessage(topics) {
  if (!Array.isArray(topics) || topics.length === 0) {
    return 'No trending topics are cached right now. Try again after the next scheduled research run.';
  }
  const lines = topics.map((t, i) => {
    const tag = `[${String(t.pillar || '?').toUpperCase()} | ${String(t.type || '?').toUpperCase()}]`;
    const pitch = t.pitch ? `\n   ${t.pitch}` : '';
    return `**${i + 1}.** ${tag} ${t.title}${pitch}`;
  });
  return `**Current trending topics**\n\n${lines.join('\n\n')}\n\nUse \`/generate <topic>\` to draft one.`;
}

// Writes a draft the SAME way POST /api/approve does: writePost() -> convert
// markdown to blocks + read time -> insert into Supabase (with the 23505
// duplicate-slug retry). Returns { draftId, slug, title, excerpt }.
// Does NOT publish. `topicInput` may be a full candidate object or a bare title.
async function runGenerate(topicInput) {
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
      const candidates = await generateCandidates({ forceFresh: false });
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

  // Minimal defaults so writePost + the posts insert always have sane values.
  topic.pitch = topic.pitch || `Ad-hoc topic requested via Discord: ${topic.title}`;
  topic.pillar = topic.pillar || 'tech';
  topic.type = topic.type || 'evergreen';
  topic.sourceNotes = topic.sourceNotes || 'Requested via Discord /generate';

  const post = await writePost(topic);
  const body = markdownToBlocks(post.bodyMarkdown, post.title);
  const readTime = computeReadTime(post.bodyMarkdown);

  const postData = {
    status: 'draft',
    slug: post.slug,
    title: post.title,
    excerpt: post.metaDescription,
    body,
    read_time: readTime,
    raw_markdown: post.bodyMarkdown,
    pillar: post.pillar,
    source_topic: post.sourceTopic,
    type: post.type,
  };

  let { data, error } = await supabase
    .from('posts')
    .insert([postData])
    .select()
    .single();

  if (error) {
    // 23505 = Postgres unique violation (duplicate slug). Retry once with a
    // short unique suffix — identical to POST /api/approve.
    if (error.code === '23505') {
      postData.slug = post.slug + '-' + Date.now().toString(36).slice(-4);
      const retry = await supabase.from('posts').insert([postData]).select().single();
      if (retry.error) throw new Error(retry.error.message);
      data = retry.data;
    } else {
      throw new Error(error.message);
    }
  }

  // Persist the topic cluster for per-cluster performance reporting (Deliverable
  // 6/7). Best-effort separate update so a missing `cluster` column only warns —
  // it never fails the draft save. Populates automatically once the column exists.
  if (post.cluster) {
    const { error: clusterErr } = await supabase
      .from('posts')
      .update({ cluster: post.cluster })
      .eq('id', data.id);
    if (clusterErr) {
      console.warn(`[discord] Could not persist cluster "${post.cluster}" (is the 'cluster' column added?): ${clusterErr.message}`);
    }
  }

  return { draftId: data.id, slug: data.slug, title: data.title, excerpt: post.metaDescription };
}

// Flips a draft to published the SAME way the dashboard publish action does
// (status='published' + published_at timestamp). Confirms the slug exists as a
// draft first; returns { ok:false, message } instead of throwing when it does
// not, so the caller can reply cleanly.
async function runPublish(slug) {
  const clean = String(slug || '').trim();
  if (!clean) return { ok: false, message: 'No slug provided.' };

  const { data: existing, error: findErr } = await supabase
    .from('posts')
    .select('id, slug, status, title')
    .eq('slug', clean)
    .maybeSingle();

  if (findErr) return { ok: false, message: `Lookup failed: ${findErr.message}` };
  if (!existing) return { ok: false, message: `No post found with slug \`${clean}\`.` };
  if (existing.status === 'published') {
    return {
      ok: false,
      message: `ℹ️ Already published: ${existing.title}\n🔗 ${LIVE_POST_BASE}/${clean}`,
    };
  }

  const { error: updErr } = await supabase
    .from('posts')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', existing.id);

  if (updErr) return { ok: false, message: `Publish failed: ${updErr.message}` };
  return {
    ok: true,
    message: `✅ Published: ${existing.title}\n🔗 ${LIVE_POST_BASE}/${clean}`,
    title: existing.title,
  };
}

// PATCHes the deferred interaction's original response with the final message.
// Uses node's built-in fetch, same one-way pattern as notifyDiscord() in
// server.js. The interaction token authorizes this call, so no bot token is
// needed and nothing secret is logged.
async function editOriginalResponse(interaction, content, components) {
  const applicationId = interaction.application_id || process.env.DISCORD_APPLICATION_ID;
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${interaction.token}/messages/@original`;
  const payload = { content: String(content).slice(0, 1990) };
  // Interaction followups are application-owned, so message components (buttons)
  // render natively — no ?with_components=true needed. Only attach when provided
  // so existing callers (publish/topics) are unaffected.
  if (Array.isArray(components) && components.length > 0) {
    payload.components = components;
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
async function handleGenerateDeferred(interaction, topicInput) {
  try {
    const { slug, title, excerpt } = await runGenerate(topicInput);
    const preview = (excerpt || '').slice(0, 300);
    const content =
      `Draft ready: **${title}**\n` +
      (preview ? `> ${preview}\n` : '') +
      `Slug: \`${slug}\`\n` +
      `Review the full draft in the dashboard: ${appUrl()}/dashboard.html`;

    // One-click Publish button (green / style 3) that reuses the EXISTING
    // publish:<slug> MESSAGE_COMPONENT handler — no new routing. Authorization
    // is enforced there (DISCORD_ALLOWED_USER_IDS); no extra confirmation step.
    // Skipped only if the custom_id would exceed Discord's 100-char limit; the
    // slug is in the text either way, so `/publish <slug>` still works.
    const publishCustomId = `publish:${slug}`;
    const components =
      publishCustomId.length <= 100
        ? [
            {
              type: 1, // ACTION_ROW
              components: [
                {
                  type: 2, // BUTTON
                  style: 3, // SUCCESS (green) — distinct from the blue Generate buttons
                  label: 'Publish',
                  custom_id: publishCustomId,
                },
              ],
            },
          ]
        : undefined;

    await editOriginalResponse(interaction, content, components);
  } catch (err) {
    console.warn('[discord] Generate failed:', err.message);
    await editOriginalResponse(interaction, `Could not generate that draft: ${err.message}`);
  }
}

async function handlePublishDeferred(interaction, slug) {
  try {
    const result = await runPublish(slug);
    await editOriginalResponse(interaction, result.message);
  } catch (err) {
    console.warn('[discord] Publish failed:', err.message);
    await editOriginalResponse(interaction, `Could not publish: ${err.message}`);
  }
}

// Button path for generate: resolve the custom_id payload to a topic first, so a
// stale button reports honestly instead of silently drafting the wrong topic.
async function handleGenerateFromRef(interaction, payload) {
  let topic;
  try {
    topic = await resolveTopicRef(payload);
  } catch (err) {
    console.warn('[discord] Topic reference lookup failed:', err.message);
    await editOriginalResponse(interaction, `Could not look that topic up: ${err.message}`);
    return;
  }
  if (topic === null) {
    await editOriginalResponse(
      interaction,
      'Those topics have since been refreshed, so this button has expired. Run `/topics` for the current list.'
    );
    return;
  }
  await handleGenerateDeferred(interaction, topic);
}

async function handleTopicsDeferred(interaction) {
  try {
    const topics = await getSelectedTopics({ forceFresh: false });
    await editOriginalResponse(interaction, formatTopicsMessage(topics));
  } catch (err) {
    console.warn('[discord] Topics failed:', err.message);
    await editOriginalResponse(interaction, `Could not load topics: ${err.message}`);
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

        if (name === 'topics') {
          // Read-only: no allow-list required. Defer (a cache miss can call
          // Claude and exceed the 3s window), then edit with the result.
          defer(res, false);
          keepAlive(handleTopicsDeferred(interaction));
          return;
        }

        if (name === 'generate') {
          if (!isAuthorized(getInvokerId(interaction))) {
            return ephemeral(res, "You're not authorized to generate posts.");
          }
          const topic = getOption(interaction, 'topic');
          if (!topic) return ephemeral(res, 'Please provide a `topic`.');
          defer(res, false); // public: visible to the whole channel
          keepAlive(handleGenerateDeferred(interaction, topic));
          return;
        }

        if (name === 'publish') {
          if (!isAuthorized(getInvokerId(interaction))) {
            return ephemeral(res, "You're not authorized to publish posts.");
          }
          const slug = getOption(interaction, 'slug');
          if (!slug) return ephemeral(res, 'Please provide a `slug`.');
          defer(res, false); // public: visible to the whole channel
          keepAlive(handlePublishDeferred(interaction, slug));
          return;
        }

        return ephemeral(res, `Unknown command: ${name}`);
      }

      // ---- Message component (button) interactions -----------------------
      // Buttons must carry a custom_id of the form "generate:<topic>" or
      // "publish:<slug>" so a click reuses the exact same logic as the slash
      // commands (no duplicated business logic).
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
          keepAlive(handlePublishDeferred(interaction, payload));
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
        return ephemeral(res, 'Something went wrong handling that interaction.');
      }
    }
  });

  console.log('[discord] Registered POST /api/discord/interactions');
}

export default registerDiscordRoutes;
