// Deliverable 4: blog post writer
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { jsonrepair } from 'jsonrepair';
import { logAnthropicUsage } from './usage.js';
import { getKeywordsForTopic, classifyCluster } from './keywords.js';

// Load environment variables
dotenv.config();

// ---------------------------------------------------------------------------
// Response shape the model is CONSTRAINED to produce (structured outputs).
//
// Passed as output_config.format so the API grammar-constrains decoding: the
// model physically cannot emit prose, self-review commentary, or code fences
// alongside the post. Kept as a frozen module-level constant so the API's
// 24h schema-compilation cache is hit on every call (a rebuilt-per-request
// schema would pay the compile cost every time).
//
// Deliberately free of minLength/maxLength — the API's JSON-schema subset does
// not support string length constraints, and length is enforced in
// validatePost() instead, where a failure can be reported properly.
// ---------------------------------------------------------------------------
const POST_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Refined, SEO-optimized title' },
    metaDescription: { type: 'string', description: '150-160 characters, keyword-optimized' },
    bodyMarkdown: { type: 'string', description: 'Full post body in markdown, roughly 500-800 words' },
  },
  required: ['title', 'metaDescription', 'bodyMarkdown'],
  additionalProperties: false,
};

// Set to false at runtime if the API ever rejects output_config (e.g. the
// feature is withdrawn or unavailable on the configured model). The parser and
// validator below are fully capable without it, so this degrades rather than
// breaks. Never flipped back within a process — one probe per boot is enough.
let structuredOutputSupported = true;

/**
 * Programmatically derives a URL-safe slug from a title string.
 *
 * @param {string} title The title of the article
 * @returns {string} URL-safe slug
 */
export function generateSlug(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')     // Remove non-word, non-space, non-hyphen characters
    .replace(/[\s_]+/g, '-')      // Replace spaces and underscores with hyphens
    .replace(/-+/g, '-');         // Remove consecutive duplicate hyphens
}

/**
 * Thrown when a generated post fails the pre-persistence content gate. Carries
 * the individual reasons so the caller can log exactly what was wrong.
 */
export class PostValidationError extends Error {
  constructor(reasons) {
    super(`Generated post failed validation: ${reasons.join('; ')}`);
    this.name = 'PostValidationError';
    this.reasons = reasons;
  }
}

/**
 * True when `value` is a plain object carrying a usable post. This single guard
 * is what stops two historic failure modes reaching the database:
 *   - jsonrepair coercing several concatenated objects into an ARRAY (whose
 *     .title/.bodyMarkdown are undefined, previously yielding a silently EMPTY
 *     published post),
 *   - any recovery path returning a shape that merely happens to be truthy.
 *
 * @param {*} value Parsed candidate
 * @returns {boolean}
 */
function looksLikePost(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    typeof value.bodyMarkdown === 'string' &&
    value.bodyMarkdown.trim().length > 0
  );
}

/**
 * Removes <cite> tags emitted by web_search. Their attributes carry double
 * quotes, so leaving them in can break an otherwise valid JSON string value —
 * this runs on the RAW text, before parsing, for exactly that reason.
 *
 * Markdown code fences are deliberately NOT stripped: extractJsonObjects()
 * ignores everything outside braces, so a fence anywhere in the response is
 * skipped naturally. Stripping them here would silently mutate body content and,
 * worse, would erase the ```json signature that validatePost() relies on to
 * detect a leaked draft.
 *
 * @param {string} text Raw response text
 * @returns {string} Cleaned text
 */
function stripResponseNoise(text) {
  return String(text || '')
    .replace(/<\/?cite\b[^>]*>/gi, '')
    .trim();
}

/**
 * Scans `raw` for brace-balanced JSON object substrings, honouring string
 * literals and backslash escapes so braces inside prose never affect depth.
 *
 * This replaces the old `indexOf('{') .. lastIndexOf('}')` span, which on a
 * response containing several objects returned ONE substring stretching from
 * the first object's opening brace to the last object's closing brace —
 * swallowing every word of commentary in between. That span was the vehicle
 * for the published-commentary incident.
 *
 * @param {string} raw Text to scan
 * @param {number} [limit=200] Safety cap; oldest candidates are dropped first
 * @returns {string[]} Complete object substrings, ordered by closing brace (so a
 *   nested object precedes the one enclosing it, and the model's final draft is
 *   always last)
 */
function extractJsonObjects(raw, limit = 200) {
  const found = [];
  const openStack = [];
  let inString = false;
  let escaped = false;

  // Single left-to-right pass, O(n). Every matched brace pair is recorded, not
  // just top-level ones, so a complete object still surfaces when an enclosing
  // one was truncated mid-write (e.g. cut off by max_tokens). looksLikePost()
  // discards any pair that isn't actually a post.
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
    } else if (ch === '{') {
      openStack.push(i);
    } else if (ch === '}' && openStack.length) {
      found.push(raw.slice(openStack.pop(), i + 1));
      // Bound memory on pathological input by dropping the OLDEST candidate —
      // the model's final draft is the most recent one, so it must survive.
      if (found.length > limit) found.shift();
    }
  }

  return found;
}

/**
 * Last-resort recovery for a SINGLE brace-balanced object whose JSON is invalid
 * — typically an unescaped double quote inside a string value. Fields are read
 * positionally ({ title, metaDescription, bodyMarkdown } in that order).
 *
 * IMPORTANT — the bodyMarkdown terminator is bounded by the candidate's final
 * closing brace. The previous implementation passed no boundary, so `close`
 * fell back to `lastIndexOf('"')` across the ENTIRE response; given several
 * concatenated drafts it captured everything from the first body's opening
 * quote to the last quote anywhere in the response. That is precisely how the
 * model's self-review commentary and two extra drafts reached the live site.
 * Callers must pass one object candidate, not a whole multi-object response.
 *
 * @param {string} raw A single brace-balanced object substring
 * @returns {object|null} { title, metaDescription, bodyMarkdown } or null
 */
function lenientExtractPost(raw) {
  // Everything after the object's own closing brace is out of bounds.
  const objectEnd = raw.lastIndexOf('}');
  const hardEnd = objectEnd === -1 ? raw.length : objectEnd;

  const valueBetween = (key, nextMarker) => {
    const k = raw.indexOf(`"${key}"`);
    if (k === -1) return null;
    const colon = raw.indexOf(':', k + key.length + 2);
    if (colon === -1) return null;
    const open = raw.indexOf('"', colon + 1);
    if (open === -1 || open >= hardEnd) return null;
    const boundary = nextMarker ? raw.indexOf(nextMarker, open + 1) : -1;
    const searchEnd = boundary === -1 ? hardEnd : Math.min(boundary, hardEnd);
    const close = raw.lastIndexOf('"', searchEnd - 1);
    if (close <= open) return null;
    return raw.slice(open + 1, close);
  };

  const unescape = (s) =>
    (s || '')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

  const title = valueBetween('title', '"metaDescription"');
  const metaDescription = valueBetween('metaDescription', '"bodyMarkdown"');
  const bodyMarkdown = valueBetween('bodyMarkdown', null);

  if (!title || !bodyMarkdown) return null;
  return {
    title: unescape(title),
    metaDescription: unescape(metaDescription),
    bodyMarkdown: unescape(bodyMarkdown),
  };
}

/**
 * Attempts to recover a post object from one chunk of response text, escalating
 * through progressively more tolerant strategies. Every strategy's result is
 * checked with looksLikePost() before being accepted, so a permissive fallback
 * can never hand back something structurally wrong.
 *
 * Candidates are tried LAST-first: when the model produced several drafts, the
 * last complete one is its final answer.
 *
 * @param {string} text Response text (already noise-stripped)
 * @returns {{post: object, strategy: string}|null}
 */
function recoverPostFromText(text) {
  const candidates = extractJsonObjects(text);
  if (!candidates.length) return null;

  // Strategies are tried in descending order of confidence, and each is applied
  // across EVERY candidate before the next one is considered. A clean parse of
  // an earlier draft is always preferable to a tolerant guess at a later one —
  // the tolerant paths exist to rescue otherwise-lost content, not to outrank
  // valid JSON.
  const strategies = [
    {
      name: 'json',
      run: (candidate) => JSON.parse(candidate),
    },
    {
      name: 'jsonrepair',
      // jsonrepair turns concatenated objects into an ARRAY, whose
      // .title/.bodyMarkdown are undefined. Accepting that previously produced a
      // draft with the topic title and a completely EMPTY body; looksLikePost()
      // below is what now rejects it.
      run: (candidate) => JSON.parse(jsonrepair(candidate)),
    },
    {
      name: 'lenient',
      run: (candidate) => lenientExtractPost(candidate),
    },
  ];

  for (const { name, run } of strategies) {
    // Last-first: when the model produced several drafts, the last complete one
    // is its final answer.
    for (let i = candidates.length - 1; i >= 0; i--) {
      let parsed = null;
      try {
        parsed = run(candidates[i]);
      } catch {
        continue; // this strategy cannot handle this candidate
      }
      if (looksLikePost(parsed)) return { post: parsed, strategy: name };
    }
  }

  return null;
}

/**
 * Selects the post from an Anthropic response's content blocks.
 *
 * Why not simply concatenate every text block (the previous behaviour): with
 * the server-side web_search tool the API runs MULTIPLE sampling turns, and
 * each turn emits its own text block. Measured against the live API, a single
 * request routinely returns two text blocks that are each a complete, valid
 * JSON object — joining them with '' yields `{...}{...}`, which can never
 * parse. Interleaved prose made the same bug produce publishable garbage.
 *
 * Blocks are therefore tried individually, newest first (the final turn is the
 * model's final answer), and only then is the concatenation scanned as a
 * fallback for responses split mid-object.
 *
 * @param {object[]} content response.content
 * @returns {{post: object, strategy: string}|null}
 */
export function parseWriterResponse(content) {
  const textBlocks = (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => stripResponseNoise(block.text))
    .filter(Boolean);

  if (!textBlocks.length) return null;

  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const recovered = recoverPostFromText(textBlocks[i]);
    if (recovered) {
      return {
        post: recovered.post,
        strategy: `block[${i}]/${recovered.strategy}`,
      };
    }
  }

  // Fallback: a single object split across block boundaries.
  const joined = recoverPostFromText(textBlocks.join(''));
  return joined ? { post: joined.post, strategy: `joined/${joined.strategy}` } : null;
}

// Signatures that mean the model's own scaffolding leaked into the article
// body. Each one is unambiguous: none can occur in a legitimate 500-800 word
// educational post written under the prompt's rules (which already forbid code
// fences, emoji/checkmarks and raw tags).
const CONTAMINATION_CHECKS = [
  { pattern: /"bodyMarkdown"\s*:/, label: 'raw JSON key "bodyMarkdown"' },
  { pattern: /"metaDescription"\s*:/, label: 'raw JSON key "metaDescription"' },
  { pattern: /"title"\s*:\s*"/, label: 'raw JSON key "title"' },
  { pattern: /```\s*json/i, label: 'embedded ```json code fence' },
  { pattern: /\b(?:wait|actually|hmm|perfect)\s*[,.]?\s*let me\b/i, label: 'model self-review commentary' },
  { pattern: /\blet me (?:recount|refine|verify|double-check|do a final)\b/i, label: 'model self-review commentary' },
  { pattern: /^\s*-?\s*rule \d+\s*:/im, label: 'rule-compliance checklist' },
  { pattern: /[✓✔]/, label: 'checklist tick mark' },
  { pattern: /<\/?(?:cite|thinking)\b/i, label: 'internal tag' },
];

// Word-count envelope. The prompt targets 500-800 words; these bounds leave
// generous headroom either side so only genuinely broken output is rejected.
// The published incident measured ~2,335 words (three drafts plus commentary);
// the jsonrepair-array bug produced 0.
const MIN_BODY_WORDS = 300;
const MAX_BODY_WORDS = 1400;
const MAX_TITLE_LENGTH = 200;

/**
 * Counts words in a markdown string.
 *
 * @param {string} markdown
 * @returns {number}
 */
function countWords(markdown) {
  return String(markdown || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Hard content gate. THROWS on anything that must never reach the posts table.
 *
 * This is the check that would have stopped the published-commentary incident
 * on its own, independently of the parser: the leaked body contained raw JSON
 * keys, a ```json fence, self-review prose and ~2,335 words. Every prior check
 * in this file was a non-blocking console.warn, and nothing between the writer
 * and the live site inspected post content at all.
 *
 * @param {object} post { title, metaDescription, bodyMarkdown }
 * @throws {PostValidationError}
 * @returns {object} The same post, when valid
 */
export function validatePost(post) {
  const reasons = [];

  if (!looksLikePost(post)) {
    throw new PostValidationError(['post is missing a usable title or bodyMarkdown']);
  }

  const { title, bodyMarkdown } = post;

  if (title.length > MAX_TITLE_LENGTH) {
    reasons.push(`title is ${title.length} chars (max ${MAX_TITLE_LENGTH})`);
  }

  const words = countWords(bodyMarkdown);
  if (words < MIN_BODY_WORDS) {
    reasons.push(`body is only ${words} words (min ${MIN_BODY_WORDS})`);
  } else if (words > MAX_BODY_WORDS) {
    reasons.push(`body is ${words} words (max ${MAX_BODY_WORDS}) — likely duplicated drafts`);
  }

  // Contamination is checked across title + meta + body: a leak can land in
  // any of the three.
  const haystack = `${title}\n${post.metaDescription || ''}\n${bodyMarkdown}`;
  for (const { pattern, label } of CONTAMINATION_CHECKS) {
    if (pattern.test(haystack)) reasons.push(`contains ${label}`);
  }

  if (bodyMarkdown.trim().startsWith('{')) {
    reasons.push('body starts with a JSON object');
  }

  if (reasons.length) throw new PostValidationError(reasons);
  return post;
}

/**
 * Builds the writing prompt for a topic.
 *
 * @param {object} topic Topic object
 * @param {string} keywordLine Pre-rendered SEO keyword line (may be empty)
 * @returns {string}
 */
function buildPrompt(topic, keywordLine) {
  return `
    You are an elite educational copywriter writing an article for Melsoft Academy, a South African training provider.
    Your task is to write a comprehensive, long-form, publish-ready blog post based on the following topic details:

    Topic Title: "${topic.title}"
    Topic Pitch: "${topic.pitch}"
    Pillar: "${topic.pillar}"
    Type: "${topic.type}"
    Source Notes: "${topic.sourceNotes}"
    ${keywordLine}

    CRITICAL WRITING RULES:
    1. EDUCATION FIRST, BUT CONCISE: The post must teach the reader clearly and get to the point quickly — no padding, no filler. Target a SHORT length of roughly 500 to 800 words total. Include only: a brief definition/context, the 2 to 4 most important points (with quick South African context and a concrete example where it genuinely helps), and a short "what to do next" takeaway. An FAQ is OPTIONAL — include at most 2 or 3 short Q&As only if they add real value, otherwise omit it entirely. Favour short paragraphs and scannable subheadings over exhaustive coverage.
    2. DUAL AUDIENCE: Write naturally for both:
       - Individual learners (B2C) trying to decide what digital or vocational skill to learn next.
       - Executives and HR managers (B2B) responsible for corporate training budgets, Skills Development Levy (SDL) recovery, and B-BBEE skills development scoring.
       Address both audiences organically and cohesively within the article; do not divide the post into separate B2B and B2C sections.
    3. SEO OPTIMIZATION: Write a keyword-optimized, compelling title and an engaging meta description (between 150 and 160 characters). Use scannable markdown formatting with clear H2 and H3 subheadings.
    4. STRICT LIMIT ON MELSOFT PROMOTION: Mention 'Melsoft' or 'Melsoft Academy' AT MOST TWICE in the entire post: once as a brief contextual mention roughly two-thirds of the way through the article, and once in a short closing call-to-action paragraph. Do not mention Melsoft anywhere else, including the introduction, headings, or FAQ section.
    5. STRICT ACCREDITATION WORDING: If you mention Melsoft at all, you MUST refer to it as "QCTO-accredited". NEVER use the phrase "SETA-accredited" when describing Melsoft, even if the article covers a SETA-funded programme.
    6. NO INVENTED STATISTICS: Every statistic or figure you use must be fact-checked and verified using the web_search tool against a real, current source. You must attribute all statistics inline (e.g., "according to [Source]"). If a statistic cannot be verified via search, do not include it. Skip it entirely rather than making an estimate or guess.
    7. TONAL PRINCIPLE: Ensure a reader who has absolutely no intention of buying from Melsoft still finds the post highly valuable, informative, and objective.
    8. CURRENT DATE AWARENESS: The current date is July 2026. Any year references in the title or body (e.g. "2026 guide," current statistics, "as of [year]") must be consistent with that, not an earlier year (like 2025), unless referring to a historical data point from a cited source (which is fine and should keep its real source year).
    9. NO TABLES: Never use markdown tables. Present comparisons or structured data as bulleted lists instead.
    10. NO EMOJI: Never use emoji anywhere in the post, including checkmarks like ✅.
    11. NO LINKS OR PLACEHOLDERS: Never include markdown hyperlinks or square-bracketed placeholder text (like "[Explore our programmes...]"). Plain text only; refer to things by name.
    12. FAQ FORMATTING (only if you include an FAQ): The section MUST begin with the H2 heading exactly "## Frequently Asked Questions" (never just "## FAQ" or "## FAQ: ..."). Format EACH question as its own H3 subheading ("### Is X worth it?") with the answer in one or more normal paragraphs directly beneath it. NEVER prefix questions or answers with "Q:" or "A:", and never combine a question and its answer into a single paragraph. Example:
       ## Frequently Asked Questions

       ### Do I need a degree to get started?

       No. Many people enter through accredited short courses and a strong portfolio...
    13. SEO KEYWORD USE (only if a "Relevant SEO Keywords" line is provided above):
    - TITLE & META DESCRIPTION: Identify the single highest-relevance keyword
      from the list. That keyword (or an unmistakably close variant — e.g.
      "course" may become "courses") MUST appear in the title, the meta
      description, or both. This is a requirement, not a suggestion — find a
      natural way to include it rather than skipping it. Only omit it entirely
      if literally no phrasing exists that avoids being grammatically broken
      or nonsensical.
    - BODY: Use the remaining keywords naturally in the body ONLY where they
      genuinely fit the sentence and topic. Never force a keyword that does not
      fit naturally — skip it instead. Body keyword usage must never compromise
      rule 1 (tight, non-padded writing) or rule 7 (objective, genuinely-valuable
      tone): if working a keyword in would add filler or make the copy read like
      an advert, leave it out.

    RESPONSE FORMAT:
    You must respond ONLY with a single valid JSON object matching the structure below.
    Do NOT include markdown code fences (like \`\`\`json), preamble, explanations, postscript,
    self-review, draft revisions, or compliance checklists. Return the finished article once.

    JSON SAFETY — the response is parsed programmatically, so invalid JSON is discarded:
    - Do NOT use the double-quote character anywhere inside bodyMarkdown, title, or metaDescription. If you need quotation marks or want to emphasise a phrase, use single quotes instead. Unescaped double quotes break the JSON.
    - Do NOT output any tags: no <cite> tags, no XML, and no HTML. Write plain markdown only, and attribute sources in plain text (for example: according to Stats SA).
    - Escape any remaining special characters correctly (newlines as \\n).
    {
      "title": "string (refined, SEO-optimized title)",
      "metaDescription": "string (150-160 characters, keyword-optimized)",
      "bodyMarkdown": "string (the full body of the post in markdown, kept concise at roughly 500-800 words: headings, a tight article body, a short 'what to do next' takeaway, and an optional brief FAQ)"
    }
  `;
}

/**
 * Generates a complete, publish-ready blog post based on a topic candidate.
 * Uses the Anthropic Claude API with web_search to verify statistics.
 *
 * The returned post has already passed validatePost(); callers may persist it
 * directly. On failure this THROWS rather than returning partial content — a
 * failed draft must never be saved.
 *
 * @param {object} topic Topic object ({ title, pitch, pillar, type, sourceNotes })
 * @returns {Promise<object>} Generated post object
 */
export async function writePost(topic) {
  if (!topic || !topic.title) {
    throw new Error('Invalid topic provided to writePost()');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not defined in process.env');
  }

  const anthropic = new Anthropic({ apiKey });

  // Resolve the topic's cluster once (used both to route SEO keywords and to
  // persist the tag on the post for per-cluster performance reporting). Null
  // when it can't be classified. Passed into getKeywordsForTopic so the keywords
  // surfaced match the cluster we store.
  const cluster = topic.cluster || classifyCluster(topic);

  // Surface relevant SEO keywords for this topic's cluster so the model can
  // weave them in naturally. Empty when no keywords are available — keywordLine
  // then contributes nothing to the prompt.
  const relevantKeywords = getKeywordsForTopic({ ...topic, cluster });
  const keywordLine = relevantKeywords.length
    ? `Relevant SEO Keywords (weave these naturally where they fit — do not force them, do not keyword-stuff, do not list them verbatim): ${relevantKeywords.join(', ')}`
    : '';

  const promptText = buildPrompt(topic, keywordLine);

  console.log(`[writePost] Querying Claude to write post for: "${topic.title}"...`);

  // One retry: a draft that fails the content gate is regenerated once rather
  // than being saved or silently dropped. Costs a second call only on failure.
  const MAX_ATTEMPTS = 2;
  let lastError = null;

  // Issues the request, transparently dropping output_config if the API ever
  // rejects it (feature withdrawn, or unavailable on the configured model). The
  // parser and validator below are fully capable without the schema, so this
  // degrades instead of failing. Self-contained so the retry cannot interfere
  // with the attempt counter.
  const requestPost = async () => {
    const baseParams = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [
        { role: 'user', content: promptText }
      ]
    };

    if (!structuredOutputSupported) {
      return anthropic.messages.create(baseParams);
    }

    try {
      return await anthropic.messages.create({
        ...baseParams,
        // Grammar-constrains decoding to POST_JSON_SCHEMA, so the model cannot
        // emit commentary or extra drafts alongside the article. Verified
        // against the live API to work alongside the server-side web_search tool
        // on this model.
        output_config: { format: { type: 'json_schema', schema: POST_JSON_SCHEMA } },
      });
    } catch (err) {
      const rejectedSchema =
        err && err.status === 400 &&
        /output_config|json_schema|output_format/i.test(String(err.message || ''));
      if (!rejectedSchema) throw err;

      console.warn('[writer] API rejected output_config — falling back to unconstrained output for this process.');
      structuredOutputSupported = false;
      return anthropic.messages.create(baseParams);
    }
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await requestPost();

    logAnthropicUsage('writer', response);

    // A truncated response yields truncated JSON. Treat it as a failed attempt
    // rather than trying to salvage a half-written article.
    if (response.stop_reason === 'max_tokens') {
      lastError = new PostValidationError(['response hit max_tokens and was truncated']);
      console.warn(`[writer] Attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError.message}`);
      continue;
    }

    const parsed = parseWriterResponse(response.content);
    if (!parsed) {
      lastError = new PostValidationError(['no valid post object found in the response']);
      console.error(
        `[writer] Attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError.message}. ` +
        `Blocks: ${(response.content || []).map((b) => b && b.type).join(', ')}`
      );
      continue;
    }

    const { post: parsedPost, strategy } = parsed;
    if (!strategy.endsWith('/json')) {
      // A clean JSON.parse of any single block is normal — with server-side
      // web_search the API runs several sampling turns and the answer legitimately
      // arrives in a later block, so that alone is not worth warning about.
      // Reaching jsonrepair or the lenient extractor IS: it means the model
      // emitted malformed JSON, which is the early warning this pipeline lacked.
      console.warn(`[writer] Post recovered via a tolerant fallback: ${strategy}`);
    }

    const cleanTitle = (parsedPost.title || topic.title).trim();
    const cleanMeta = (parsedPost.metaDescription || '').trim();
    const cleanBody = (parsedPost.bodyMarkdown || '').trim();

    try {
      validatePost({ title: cleanTitle, metaDescription: cleanMeta, bodyMarkdown: cleanBody });
    } catch (err) {
      lastError = err;
      console.error(`[writer] Attempt ${attempt}/${MAX_ATTEMPTS} rejected — ${err.message}`);
      continue;
    }

    // Soft editorial checks: worth flagging for review, but not grounds to
    // discard an otherwise well-formed article.
    const melsoftCount = (cleanBody.match(/Melsoft/gi) || []).length;
    if (melsoftCount > 2) {
      console.warn(`WARNING: Melsoft mentioned more than twice (${melsoftCount} times) — review for over-promotion`);
    }
    if (/SETA-accredited/i.test(cleanBody)) {
      console.warn('WARNING: Article contains the phrase "SETA-accredited" — Melsoft must only ever be described as "QCTO-accredited"');
    }

    return {
      title: cleanTitle,
      slug: generateSlug(cleanTitle),
      metaDescription: cleanMeta,
      bodyMarkdown: cleanBody,
      pillar: topic.pillar,
      cluster,
      type: topic.type,
      sourceTopic: topic.title
    };
  }

  throw lastError || new PostValidationError(['post generation failed for an unknown reason']);
}

// standalone run block
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('--- STANDALONE TESTING: src/writer.js ---');

  const sampleTopic = {
    title: "A Beginner's Guide to Breaking Into Data Science in SA",
    pitch: "An entry-level roadmap to starting a data science career in South Africa, outlining the essential skills and local industry demand.",
    pillar: "tech",
    type: "evergreen",
    sourceNotes: "evergreen bank"
  };

  writePost(sampleTopic)
    .then(async post => {
      console.log('\n--- Successfully Generated Blog Post ---\n');
      console.log('Title:            ', post.title);
      console.log('Slug:             ', post.slug);
      console.log('Pillar:           ', post.pillar);
      console.log('Type:             ', post.type);
      console.log('Source Topic:     ', post.sourceTopic);
      console.log('Meta Description: ', post.metaDescription);

      const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const outputJsonPath = path.join(projectRoot, 'output.json');
      const outputMdPath = path.join(projectRoot, 'output.md');

      await fs.writeFile(outputJsonPath, JSON.stringify(post, null, 2), { encoding: 'utf8' });
      await fs.writeFile(outputMdPath, post.bodyMarkdown, { encoding: 'utf8' });

      console.log('\nFull post written to output.json and output.md\n');
    })
    .catch(err => {
      console.error('Failed standalone writing run:', err);
    });
}
