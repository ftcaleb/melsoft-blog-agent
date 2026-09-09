// Deliverable 1: research agent
import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logAnthropicUsage } from './usage.js';
import { supabase } from './supabaseClient.js';
import { notifyFailure } from './notify.js';
import { getProfile } from './profiles.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to resolve paths from project root
const getProjectPath = (relPath) => path.resolve(__dirname, '..', relPath);

// Research cache config (Supabase-backed).
// The expensive part of research is the live web_search call for "recent"
// trending topics. We cache ONLY that result — in a single Supabase row so it
// persists across serverless invocations (unlike the old on-disk file, which
// Vercel's read-only/ephemeral filesystem could not keep). Freshness is driven
// by the scheduled cron (Tue/Fri) plus an explicit ?fresh=true bypass, so
// ordinary page loads read the cache and never trigger a billed research call.
const RESEARCH_CACHE_TABLE = 'research_cache';
// Each content line gets its own cache row so their candidate batches never
// clobber each other. Academy keeps its original row id (1) for a no-op
// migration; Digital gets a new row.
const RESEARCH_CACHE_ROW_IDS = { academy: 1, digital: 2 };

/**
 * Calculates the Levenshtein distance between two strings.
 */
function levenshteinDistance(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,       // deletion
        matrix[i][j - 1] + 1,       // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[len1][len2];
}

/**
 * Checks if two titles are close or fuzzy matches.
 */
function isFuzzyMatch(title1, title2) {
  if (!title1 || !title2) return false;
  
  const t1 = title1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t2 = title2.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Direct substring check
  if (t1.includes(t2) || t2.includes(t1)) {
    return true;
  }
  
  // Levenshtein similarity check
  const maxLen = Math.max(t1.length, t2.length);
  if (maxLen === 0) return true;
  const dist = levenshteinDistance(t1, t2);
  const similarity = 1 - dist / maxLen;
  return similarity > 0.85; // 85% similarity threshold
}

// ---------------------------------------------------------------------------
// Response parsing.
//
// This file previously carried the same defect as the writer: it joined EVERY
// text block with '' and then took the greedy `indexOf('[') .. lastIndexOf(']')`
// span. With the server-side web_search tool the API runs multiple sampling
// turns, each emitting its own text block, so a single request can return two
// complete JSON arrays. Joined, they became `[...][...]`, which JSON.parse
// rejects; jsonrepair then coerced them into an ARRAY OF ARRAYS whose every
// element had `title === undefined`. Array.isArray() was true, so the poisoned
// batch was returned, PERSISTED to the research_cache row, and served for a day:
// Discord posted topics named "undefined" with buttons that resolved to nothing.
// ---------------------------------------------------------------------------

// Builds the candidates schema for a profile's category set. Kept as a plain
// function (not a frozen constant) since the enum now varies per profile —
// the API's 24h schema-compilation cache is still hit per distinct schema
// shape, just no longer per-process-wide singleton.
function candidatesJsonSchema(categories) {
  return {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            pitch: { type: 'string' },
            pillar: { type: 'string', enum: categories },
            type: { type: 'string' },
            sourceNotes: { type: 'string' },
          },
          required: ['title', 'pitch', 'pillar', 'type', 'sourceNotes'],
          additionalProperties: false,
        },
      },
    },
    required: ['candidates'],
    additionalProperties: false,
  };
}

// Cleared if the API ever rejects output_config; the parser below is fully
// capable without it, so this degrades rather than breaks. Tracked per
// profile since a rejection for one line says nothing about the other.
const structuredOutputSupported = { academy: true, digital: true };

/**
 * Scans for balanced JSON object/array substrings, honouring string literals and
 * escapes so brackets inside prose or inside a value never affect depth.
 * Single pass, O(n).
 *
 * @param {string} raw
 * @param {number} [limit=200] Cap; oldest candidates are dropped first
 * @returns {string[]} Balanced substrings, ordered by closing bracket
 */
function extractJsonValues(raw, limit = 200) {
  const found = [];
  const stack = [];
  const closerFor = { '{': '}', '[': ']' };
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push({ open: ch, index: i });
    } else if ((ch === '}' || ch === ']') && stack.length) {
      const top = stack.pop();
      // Only record a genuinely matched pair. A mismatch means malformed input;
      // popping without recording keeps the stack from wedging.
      if (closerFor[top.open] === ch) {
        found.push(raw.slice(top.index, i + 1));
        // Keep the most recent candidates — the model's final list is last.
        if (found.length > limit) found.shift();
      }
    }
  }

  return found;
}

/**
 * Normalizes one raw candidate, or returns null if it is unusable.
 * Forgiving where it safely can be (case, missing optional prose) and strict on
 * the two fields the pipeline genuinely depends on: a real title and a pillar
 * that matches one of this profile's categories.
 *
 * @param {*} value
 * @param {string[]} categories Valid pillar/category values for the active profile
 * @returns {object|null}
 */
function normalizeCandidate(value, categories) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (title.length < 8) return null;

  // Case-insensitive match, but the CANONICAL casing from the profile's
  // category list is what gets stored — 'ai' from the model normalizes to
  // 'AI' for Digital, matching profiles.js and select.js exactly.
  const raw = String(value.pillar || '').trim().toLowerCase();
  const pillar = categories.find((c) => c.toLowerCase() === raw);
  if (!pillar) return null;

  return {
    title,
    pitch: typeof value.pitch === 'string' ? value.pitch.trim() : '',
    pillar,
    type: typeof value.type === 'string' && value.type.trim() ? value.type.trim() : 'recent',
    sourceNotes: typeof value.sourceNotes === 'string' ? value.sourceNotes.trim() : '',
  };
}

/**
 * Extracts the candidate list from a parsed value, accepting either the
 * `{ candidates: [...] }` envelope or a bare `[...]` array (the legacy shape, and
 * what an unconstrained fallback response still produces).
 *
 * @param {*} parsed
 * @param {string[]} categories Valid pillar/category values for the active profile
 * @returns {object[]} Valid, normalized candidates (possibly empty)
 */
function normalizeCandidateList(parsed, categories) {
  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.candidates)) list = parsed.candidates;
  if (!list) return [];

  // Flatten one level: this is exactly the array-of-arrays jsonrepair produces
  // from two concatenated lists, so flattening recovers real candidates instead
  // of discarding the whole batch.
  const flat = list.some(Array.isArray) ? list.flat() : list;

  return flat.map((v) => normalizeCandidate(v, categories)).filter(Boolean);
}

/**
 * Selects the candidate list from an Anthropic response's content blocks.
 *
 * Blocks are tried individually, newest first (with server tools the final turn
 * holds the model's final answer), before the concatenation is scanned as a
 * fallback for a list split across block boundaries. Strategies escalate from
 * JSON.parse to jsonrepair, and every result must yield at least one valid
 * candidate to be accepted.
 *
 * @param {object[]} content response.content
 * @param {string[]} [categories] Valid pillar/category values; defaults to Academy's for backward compatibility
 * @returns {object[]} Valid, normalized candidates (empty if none found)
 */
export function parseCandidatesResponse(content, categories = getProfile('academy').categories) {
  const textBlocks = (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.replace(/<\/?cite\b[^>]*>/gi, '').trim())
    .filter(Boolean);

  if (!textBlocks.length) return [];

  const strategies = [
    (candidate) => JSON.parse(candidate),
    (candidate) => JSON.parse(jsonrepair(candidate)),
  ];

  const scan = (text) => {
    const values = extractJsonValues(text);
    for (const run of strategies) {
      for (let i = values.length - 1; i >= 0; i--) {
        let parsed;
        try {
          parsed = run(values[i]);
        } catch {
          continue;
        }
        const list = normalizeCandidateList(parsed, categories);
        if (list.length) return list;
      }
    }
    return [];
  };

  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const list = scan(textBlocks[i]);
    if (list.length) return list;
  }

  return scan(textBlocks.join(''));
}

/**
 * Performs the live, billable web_search call to Anthropic to fetch recent
 * trending candidate topics. This is the expensive operation the cache exists
 * to avoid. Throws on a hard API/parse failure so callers don't cache garbage.
 *
 * @param {import('./profiles.js').SiteProfile} profile
 * @returns {Promise<Array>} Array of recent candidate topic objects (non-empty)
 */
export async function fetchRecentCandidates(profile = getProfile('academy')) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('Warning: ANTHROPIC_API_KEY is not defined in process.env. Skipping recent candidates generation.');
    return [];
  }

  const anthropic = new Anthropic({ apiKey });

  // Semantic-dedupe assist: pull the titles of already-covered posts and hand
  // them to the model so it doesn't re-discover the same story in new wording
  // (the downstream string filter only catches near-literal re-proposals).
  // Never crash research if Supabase is unreachable — warn and skip exclusion.
  // Scoped to THIS profile's table, so Academy and Digital never suppress each
  // other's topics.
  let excludedSection = '';
  const { data: coveredRows, error: coveredErr } = await supabase
    .from(profile.table)
    .select('title')
    .order('created_at', { ascending: false });
  if (coveredErr) {
    console.warn('Warning: Could not fetch covered post titles for research exclusion. Proceeding with no exclusion list.', coveredErr.message);
  } else if (Array.isArray(coveredRows)) {
    const excludedTitles = [...new Set(
      coveredRows.map(row => row.title).filter(Boolean)
    )].slice(0, 40);
    if (excludedTitles.length > 0) {
      excludedSection = `
    ALREADY COVERED — do not propose these topics again, nor reworded or re-angled variants of the same underlying story:
${excludedTitles.map(t => `    - ${t}`).join('\n')}
`;
    }
  }

  const promptText = `${profile.researchPrompt}
${excludedSection}
    CRITICAL REQUIREMENTS:
    1. Every candidate must have a clear "what it means / why it matters" angle for the reader, not just reporting "what happened".
    2. Return ONLY a single valid JSON object with a "candidates" array.
    3. Do NOT include markdown code fences (like \`\`\`json), preamble, explanations, postscript, self-review, or revised versions of the list. Return the list once.
    4. Each entry in "candidates" must match this exact shape:
    {
      "title": "string",
      "pitch": "string (one-line description of the angle)",
      "pillar": ${profile.categories.map((c) => `"${c}"`).join(' or ')},
      "type": "recent",
      "sourceNotes": "string (details of the source or URL found)"
    }
  `;

  const baseParams = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2500,
    // max_uses capped at 2, not 3: Vercel's 60s maxDuration (Hobby plan, can't
    // be raised without upgrading) was measured hard-timing out this call for
    // Digital's "trending globally" prompt — a far broader, more saturated
    // search space than Academy's narrow SA-training-market niche, so it was
    // plausibly spending its search budget more freely. Fewer allowed search
    // round-trips bounds worst-case latency for both profiles; Academy was
    // never observed timing out, so this is pure safety margin there.
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    messages: [
      { role: 'user', content: promptText }
    ]
  };

  let response;
  if (!structuredOutputSupported[profile.key]) {
    response = await anthropic.messages.create(baseParams);
  } else {
    try {
      response = await anthropic.messages.create({
        ...baseParams,
        // Grammar-constrains decoding, so the model cannot emit commentary or a
        // second revised list alongside the candidates. Verified against the live
        // API to work alongside the server-side web_search tool on this model.
        output_config: { format: { type: 'json_schema', schema: candidatesJsonSchema(profile.categories) } },
      });
    } catch (err) {
      const rejectedSchema =
        err && err.status === 400 &&
        /output_config|json_schema|output_format/i.test(String(err.message || ''));
      if (!rejectedSchema) throw err;
      console.warn('[research] API rejected output_config — falling back to unconstrained output for this process.');
      structuredOutputSupported[profile.key] = false;
      response = await anthropic.messages.create(baseParams);
    }
  }

  logAnthropicUsage('research', response);

  const recentCandidates = parseCandidatesResponse(response.content, profile.categories);

  if (!recentCandidates.length) {
    // Throw rather than return [] so callers never cache an empty batch over a
    // good one. fetchRecentCandidates()'s contract already documents this.
    throw new Error(
      '[research] No valid candidates found in the response ' +
      `(stop_reason=${response.stop_reason}, blocks=${(response.content || []).map(b => b && b.type).join(', ')})`
    );
  }

  console.log(`[research] Parsed ${recentCandidates.length} valid candidate(s).`);
  return recentCandidates;
}

/**
 * Forces a live regeneration of the recent-candidates cache and persists it to
 * this profile's Supabase research_cache row. Called by the daily cron
 * (/api/cron/refresh-topics) and on an explicit ?fresh=true bypass.
 *
 * @param {import('./profiles.js').SiteProfile} profile
 * @returns {Promise<Array>} The freshly fetched recent candidates
 */
export async function refreshResearchCache(profile = getProfile('academy')) {
  const candidates = await fetchRecentCandidates(profile);
  const generatedAt = new Date().toISOString();

  try {
    const { error } = await supabase
      .from(RESEARCH_CACHE_TABLE)
      .upsert({ id: RESEARCH_CACHE_ROW_IDS[profile.key] || 1, generated_at: generatedAt, candidates });
    if (error) throw error;
    console.log(`[research] Cache REFRESHED in Supabase (${profile.key}) — ${candidates.length} recent candidates at ${generatedAt}.`);
  } catch (writeErr) {
    // Non-fatal: we still return the candidates for this run. This also covers
    // the case where the research_cache table has not been created yet.
    console.warn('[research] Could not persist research cache to Supabase:', writeErr.message);
  }

  return candidates;
}

/**
 * Returns recent candidates from the Supabase cache. Freshness is driven by the
 * cron (and ?fresh=true), NOT by a read-time TTL — so ordinary page loads serve
 * the cache with no billed research call. A live regeneration happens only on:
 *   - forceFresh === true  (e.g. GET /api/topics?fresh=true),
 *   - process.env.DISABLE_RESEARCH_CACHE === 'true', or
 *   - an empty/absent cache (first run, or before the table exists).
 *
 * @param {{ forceFresh?: boolean, profile?: import('./profiles.js').SiteProfile }} options
 * @returns {Promise<Array>} Array of recent candidate topic objects
 */
export async function getRecentCandidatesCached({ forceFresh = false, profile = getProfile('academy') } = {}) {
  const bypass = forceFresh || process.env.DISABLE_RESEARCH_CACHE === 'true';

  // Load the cached row from Supabase (may not exist yet / table may be absent).
  let cache = null;
  const { data, error } = await supabase
    .from(RESEARCH_CACHE_TABLE)
    .select('generated_at, candidates')
    .eq('id', RESEARCH_CACHE_ROW_IDS[profile.key] || 1)
    .maybeSingle();
  if (error) {
    console.warn('[research] Could not read research cache from Supabase (will regenerate):', error.message);
  } else if (data && Array.isArray(data.candidates)) {
    cache = data;
  }

  // Serve the cache whenever it exists and we are not explicitly bypassing.
  if (!bypass && cache && cache.candidates.length > 0) {
    const ageMin = cache.generated_at
      ? Math.round((Date.now() - new Date(cache.generated_at).getTime()) / 60000)
      : null;
    console.log(`[research] Cache HIT (${profile.key}) — ${cache.candidates.length} recent candidates${ageMin != null ? ` (age ${ageMin} min)` : ''}.`);
    return cache.candidates;
  }

  if (bypass) {
    const reason = forceFresh ? 'fresh=true query param' : 'DISABLE_RESEARCH_CACHE=true';
    console.log(`[research] Cache BYPASS (${profile.key}) — forcing live regeneration (${reason}).`);
  } else {
    console.log(`[research] Cache MISS (${profile.key}) — no cached candidates, regenerating.`);
  }

  try {
    return await refreshResearchCache(profile);
  } catch (regenErr) {
    // Live regeneration failed — fall back to whatever cache we have rather than
    // silently dropping all recent topics.
    console.error('[research] Live regeneration FAILED:', regenErr.message);

    // Raise a visible alert: a regeneration failure is otherwise console-only,
    // and the stale-cache fallback below makes it invisible in the UI too.
    // Non-blocking — the fallback must happen regardless.
    const fellBackToCache = !!(cache && Array.isArray(cache.candidates));
    await notifyFailure(
      `Topic research (${profile.label})`,
      fellBackToCache
        ? 'Live regeneration failed; serving the previous cached topics. The cache was NOT overwritten.'
        : 'Live regeneration failed and no cache was available — no recent topics this run.',
      [regenErr.message]
    );

    if (fellBackToCache) {
      console.warn('[research] Falling back to cached candidates.');
      return cache.candidates;
    }
    console.warn('[research] No cache available to fall back on — returning no recent candidates.');
    return [];
  }
}

/**
 * Produces a list of candidate blog topics for the given content line.
 * Combines recent web-searched trends with evergreen topics (Academy only —
 * Digital has no evergreen bank yet, being pure news/commentary). The
 * expensive recent-trends search is served from a 24h cache; evergreen topics
 * and dedup against this profile's Supabase table always run fresh, so
 * newly-saved posts (even drafts still in review) are excluded immediately.
 *
 * @param {{ forceFresh?: boolean, profile?: import('./profiles.js').SiteProfile }} options Pass forceFresh to bypass the cache
 * @returns {Promise<Array>} List of candidate topic objects
 */
export async function generateCandidates({ forceFresh = false, profile = getProfile('academy') } = {}) {
  // 1. Read evergreen topics — Academy only.
  let evergreenCandidates = [];
  if (profile.key === 'academy') {
    const evergreenPath = getProjectPath('data/evergreen_topics.json');
    try {
      const evergreenRaw = await fs.readFile(evergreenPath, 'utf8');
      const evergreenTopics = JSON.parse(evergreenRaw);
      evergreenCandidates = evergreenTopics.map(topic => ({
        title: topic.title,
        pitch: topic.pitch,
        pillar: topic.pillar,
        cluster: topic.cluster, // carry the hand-tagged cluster through to the writer
        type: 'evergreen',
        sourceNotes: 'evergreen bank'
      }));
    } catch (error) {
      console.warn('Warning: Could not read evergreen_topics.json. Defaulting to empty.', error.message);
    }
  }

  // 2. Fetch past posts from THIS profile's table for deduping.
  // We pull EVERY row regardless of status — a draft still in review already
  // "covers" its topic, so it should suppress re-proposals. If Supabase is
  // unreachable, research must degrade gracefully rather than crash, so we
  // warn and continue with an empty past list.
  let pastPosts = [];
  const { data, error } = await supabase.from(profile.table).select('title, source_topic');
  if (error) {
    console.warn('Warning: Could not fetch past posts from Supabase for deduping. Continuing with an empty past list.', error.message);
  } else if (Array.isArray(data)) {
    pastPosts = data;
  }

  // 3. Fetch recent trending candidates (served from the 24h cache unless bypassed)
  const recentCandidates = await getRecentCandidatesCached({ forceFresh, profile });

  // 4. Combine recent and evergreen candidates
  const allCandidates = [...recentCandidates, ...evergreenCandidates];

  // 5. Deduplicate against past posts.
  // Match against BOTH the stored title AND source_topic: the writer refines
  // titles after selection (e.g. "...Breaking Into Data Science in SA" →
  // "...in South Africa (2026 Roadmap)"), which drops the pair below the 0.85
  // similarity threshold, but source_topic preserves the original candidate
  // title verbatim and still catches the duplicate.
  const filteredCandidates = allCandidates.filter(candidate => {
    const isDuplicate = pastPosts.some(pastPost =>
      isFuzzyMatch(candidate.title, pastPost.title) ||
      isFuzzyMatch(candidate.title, pastPost.source_topic)
    );
    return !isDuplicate;
  });

  return filteredCandidates;
}

// standalone run block
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('--- STANDALONE TESTING: src/research.js ---');
  console.log('Generating candidates...');
  
  generateCandidates()
    .then(candidates => {
      console.log(`\nSuccessfully generated ${candidates.length} candidates:\n`);
      console.log(JSON.stringify(candidates, null, 2));
    })
    .catch(err => {
      console.error('Failed standalone run:', err);
    });
}
