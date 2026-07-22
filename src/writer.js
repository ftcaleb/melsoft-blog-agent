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
 * Last-resort recovery when JSON.parse and jsonrepair both fail — typically
 * because the model left an unescaped double quote inside a string value. The
 * response shape is fixed ({ title, metaDescription, bodyMarkdown } in that
 * order), so we extract each field's value as the text between its opening quote
 * and the closing quote just before the next key (or the end for bodyMarkdown).
 * This tolerates stray double quotes inside the values, then unescapes the
 * standard JSON escapes.
 *
 * @param {string} raw The (fence/cite-stripped) response text
 * @returns {object|null} { title, metaDescription, bodyMarkdown } or null
 */
function lenientExtractPost(raw) {
  const valueBetween = (key, nextMarker) => {
    const k = raw.indexOf(`"${key}"`);
    if (k === -1) return null;
    const colon = raw.indexOf(':', k + key.length + 2);
    if (colon === -1) return null;
    const open = raw.indexOf('"', colon + 1);
    if (open === -1) return null;
    const boundary = nextMarker ? raw.indexOf(nextMarker, open + 1) : -1;
    const searchEnd = boundary === -1 ? raw.length : boundary;
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
 * Generates a complete, publish-ready blog post based on a topic candidate.
 * Uses the Anthropic Claude API with web_search to verify statistics.
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

  const promptText = `
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
    4. STRICT LIMIT ON MELSOFT PROMOTION: Mention 'Melsoft' or 'Melsoft Academy' AT MOST TWICE in the entire post: once as a brief contextual mention roughly two-thirds of the way through the article, and once in a short closing call-to-action paragraph. Do not mention Melsoft anywhere else, including the introduction, headings, or FAQ section. Before finalizing your response, count your own Melsoft mentions and remove any beyond these two.
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
    You must respond ONLY with a valid JSON object matching the following structure.
    Do NOT include markdown code fences (like \`\`\`json), preamble, explanations, or postscript.

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

  console.log(`[writePost] Querying Claude to write post for: "${topic.title}"...`);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [
      { role: 'user', content: promptText }
    ]
  });

  logAnthropicUsage('writer', response);

  // Safely concatenate all text blocks in case of intermediate tool use blocks
  let responseText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  // Strip code fences if present
  if (responseText.startsWith('```')) {
    responseText = responseText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  }

  // Defensive: remove any <cite ...> / </cite> tags from the RAW text before
  // parsing. web_search responses sometimes wrap cited claims in <cite> tags
  // whose attributes carry quotes; stripping them here (in addition to the
  // post-parse cleanup below) keeps them from ever contributing to a JSON parse
  // failure. Safe because these tags are never valid post content anyway.
  responseText = responseText.replace(/<\/?cite\b[^>]*>/gi, '');

  // Extract JSON object substring to strip any preamble or postscript text
  const firstBrace = responseText.indexOf('{');
  const lastBrace = responseText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    responseText = responseText.substring(firstBrace, lastBrace + 1);
  }

  let parsedPost;
  try {
    parsedPost = JSON.parse(responseText);
  } catch (err) {
    console.warn('[writer] Standard JSON.parse failed. Attempting repair with jsonrepair...');
    try {
      const repairedText = jsonrepair(responseText);
      parsedPost = JSON.parse(repairedText);
      console.log('[writer] JSON repaired and parsed successfully!');
    } catch (repairErr) {
      console.warn('[writer] jsonrepair failed. Attempting lenient field extraction...');
      parsedPost = lenientExtractPost(responseText);
      if (!parsedPost) {
        console.error('Failed to parse and repair Claude JSON response. Raw response was:', responseText);
        throw new Error(`JSON parsing failed: ${err.message}`);
      }
      console.log('[writer] Recovered post via lenient field extraction.');
    }
  }

  // Post-processing cleanup: strip <cite> tags from title, meta description, and body
  const citeRegex = /<cite[^>]*>(.*?)<\/cite>/gs;
  const cleanTitle = (parsedPost.title || topic.title).replace(citeRegex, '$1');
  const cleanMeta = (parsedPost.metaDescription || '').replace(citeRegex, '$1');
  const cleanBody = (parsedPost.bodyMarkdown || '').replace(citeRegex, '$1');

  // Validation checks: check Melsoft mention count
  const melsoftCount = (cleanBody.match(/Melsoft/gi) || []).length;
  if (melsoftCount > 2) {
    console.warn(`WARNING: Melsoft mentioned more than twice (${melsoftCount} times) — review for over-promotion`);
  }

  // Validation checks: check for forbidden accreditation terms
  if (/SETA-accredited/i.test(cleanBody)) {
    console.warn('WARNING: Article contains the phrase "SETA-accredited" — Melsoft must only ever be described as "QCTO-accredited"');
  }

  // Format output object
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
