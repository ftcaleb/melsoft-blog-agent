// Deliverable 1: research agent
import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logAnthropicUsage } from './usage.js';
import { supabase } from './supabaseClient.js';

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
const RESEARCH_CACHE_ROW_ID = 1;

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

/**
 * Performs the live, billable web_search call to Anthropic to fetch recent
 * trending candidate topics. This is the expensive operation the cache exists
 * to avoid. Throws on a hard API/parse failure so callers don't cache garbage.
 *
 * @returns {Promise<Array>} Array of recent candidate topic objects (possibly empty)
 */
export async function fetchRecentCandidates() {
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
  let excludedSection = '';
  const { data: coveredRows, error: coveredErr } = await supabase
    .from('posts')
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

  const promptText = `
    You are a research agent for Melsoft Academy, a South African training provider.

    Using the web_search tool, find what's trending in South Africa in the last ~2 weeks across these topics ONLY:
    - AI, cybersecurity, data science (tech pillar)
    - learnerships, B-BBEE, SETA landscape, employment equity targets, QCTO qualifications, youth upskilling (skills pillar)

    Based on your findings, formulate a list of trending candidate blog post topics for Melsoft Academy.
${excludedSection}
    CRITICAL REQUIREMENTS:
    1. Every candidate must have BOTH a South African angle and an educational "what it means / what to do" angle (practical value/insights for learners, companies, or the local community), not just reporting "what happened".
    2. Return ONLY a valid JSON array of candidate objects.
    3. Do NOT include markdown code fences (like \`\`\`json), preamble, explanations, or postscript.
    4. The array must contain objects matching this exact shape:
    {
      "title": "string",
      "pitch": "string (one-line description of the angle)",
      "pillar": "tech" or "skills",
      "type": "recent",
      "sourceNotes": "string (details of the source or URL found)"
    }
  `;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [
      { role: 'user', content: promptText }
    ]
  });

  logAnthropicUsage('research', response);

  let responseText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  // Defensively strip code fences if present
  if (responseText.startsWith('```')) {
    responseText = responseText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  }

  // Extract JSON array substring to strip any conversational preamble
  // (e.g. "I'll search for...") that the model emits alongside web_search tool use
  const firstBracket = responseText.indexOf('[');
  const lastBracket = responseText.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1) {
    responseText = responseText.substring(firstBracket, lastBracket + 1);
  }

  let recentCandidates;
  try {
    recentCandidates = JSON.parse(responseText);
  } catch (parseErr) {
    console.warn('[research] Standard JSON.parse failed. Attempting repair with jsonrepair...');
    recentCandidates = JSON.parse(jsonrepair(responseText));
    console.log('[research] JSON repaired and parsed successfully!');
  }

  return Array.isArray(recentCandidates) ? recentCandidates : [];
}

/**
 * Forces a live regeneration of the recent-candidates cache and persists it to
 * the Supabase research_cache row. Called by the Tue/Fri cron
 * (/api/cron/refresh-topics) and on an explicit ?fresh=true bypass.
 *
 * @returns {Promise<Array>} The freshly fetched recent candidates
 */
export async function refreshResearchCache() {
  const candidates = await fetchRecentCandidates();
  const generatedAt = new Date().toISOString();

  try {
    const { error } = await supabase
      .from(RESEARCH_CACHE_TABLE)
      .upsert({ id: RESEARCH_CACHE_ROW_ID, generated_at: generatedAt, candidates });
    if (error) throw error;
    console.log(`[research] Cache REFRESHED in Supabase — ${candidates.length} recent candidates at ${generatedAt}.`);
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
 * @param {{ forceFresh?: boolean }} options
 * @returns {Promise<Array>} Array of recent candidate topic objects
 */
export async function getRecentCandidatesCached({ forceFresh = false } = {}) {
  const bypass = forceFresh || process.env.DISABLE_RESEARCH_CACHE === 'true';

  // Load the cached row from Supabase (may not exist yet / table may be absent).
  let cache = null;
  const { data, error } = await supabase
    .from(RESEARCH_CACHE_TABLE)
    .select('generated_at, candidates')
    .eq('id', RESEARCH_CACHE_ROW_ID)
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
    console.log(`[research] Cache HIT — ${cache.candidates.length} recent candidates${ageMin != null ? ` (age ${ageMin} min)` : ''}.`);
    return cache.candidates;
  }

  if (bypass) {
    const reason = forceFresh ? 'fresh=true query param' : 'DISABLE_RESEARCH_CACHE=true';
    console.log(`[research] Cache BYPASS — forcing live regeneration (${reason}).`);
  } else {
    console.log('[research] Cache MISS — no cached candidates, regenerating.');
  }

  try {
    return await refreshResearchCache();
  } catch (regenErr) {
    // Live regeneration failed — fall back to whatever cache we have rather than
    // silently dropping all recent topics.
    console.error('[research] Live regeneration FAILED:', regenErr.message);
    if (cache && Array.isArray(cache.candidates)) {
      console.warn('[research] Falling back to cached candidates.');
      return cache.candidates;
    }
    console.warn('[research] No cache available to fall back on — returning no recent candidates.');
    return [];
  }
}

/**
 * Produces a list of candidate blog topics for Melsoft Academy.
 * Combines recent web-searched trends in South Africa with evergreen topics.
 * The expensive recent-trends search is served from a 24h cache; evergreen
 * topics and dedup against the Supabase posts table always run fresh, so
 * newly-saved posts (even drafts still in review) are excluded immediately.
 *
 * @param {{ forceFresh?: boolean }} options Pass forceFresh to bypass the cache
 * @returns {Promise<Array>} List of candidate topic objects
 */
export async function generateCandidates({ forceFresh = false } = {}) {
  const evergreenPath = getProjectPath('data/evergreen_topics.json');

  // 1. Read evergreen topics
  let evergreenCandidates = [];
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

  // 2. Fetch past posts from Supabase for deduping.
  // We pull EVERY row regardless of status — a draft still in review already
  // "covers" its topic, so it should suppress re-proposals. If Supabase is
  // unreachable, research must degrade gracefully rather than crash, so we
  // warn and continue with an empty past list.
  let pastPosts = [];
  const { data, error } = await supabase.from('posts').select('title, source_topic');
  if (error) {
    console.warn('Warning: Could not fetch past posts from Supabase for deduping. Continuing with an empty past list.', error.message);
  } else if (Array.isArray(data)) {
    pastPosts = data;
  }

  // 3. Fetch recent trending candidates (served from the 24h cache unless bypassed)
  const recentCandidates = await getRecentCandidatesCached({ forceFresh });

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
