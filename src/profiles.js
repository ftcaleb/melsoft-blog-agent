// Deliverable: per-content-line "site profile".
//
// The pipeline (research -> select -> write -> image -> Discord -> Supabase)
// was built for exactly one brand: Melsoft Academy. This module is the seam
// that lets a second, independent content line — Melsoft Digital's public
// tech/AI commentary — run through the SAME hardened infrastructure (retry
// logic, image gen, Discord error handling) instead of forking a parallel
// pipeline. Every call site that used to hardcode Academy's rules now takes a
// profile object from here instead.
//
// Adding a THIRD line later means adding one more entry to PROFILES — nothing
// else in this file changes shape.

/**
 * @typedef {object} SiteProfile
 * @property {'academy'|'digital'} key
 * @property {string} label Human-readable name, used in Discord messages
 * @property {string} table Supabase table this line's posts live in
 * @property {string[]} categories Valid category/pillar values for this line
 * @property {string} researchPrompt Web-search brief handed to the research agent
 * @property {string} writerVoice Brand-voice block interpolated into buildPrompt()
 * @property {string|null} author Fixed byline, or null when the line has no byline concept
 * @property {string} imageStyle Default IMAGE_STYLE for this line's featured images
 * @property {string} imageFraming One-line framing injected into imageGen's scene-brief prompt
 * @property {Record<string,string>} fallbackScenes Offline fallback scene per category, keyed lowercase
 * @property {Record<string,string>} categoryTint Maps a category to a CSS tint var on the target site
 * @property {string} liveBase Production domain a published post's slug is appended to
 */

/** @type {Record<string, SiteProfile>} */
export const PROFILES = {
  academy: {
    key: 'academy',
    label: 'Academy',
    table: 'posts',
    categories: ['tech', 'skills'],

    researchPrompt: `
    You are a research agent for Melsoft Academy, a South African training provider.

    Using the web_search tool, find what's trending in South Africa in the last ~2 weeks across these topics ONLY:
    - AI, cybersecurity, data science (tech pillar)
    - learnerships, B-BBEE, SETA landscape, employment equity targets, QCTO qualifications, youth upskilling (skills pillar)

    Based on your findings, formulate a list of trending candidate blog post topics for Melsoft Academy.`,

    // The exact voice block that lived inline in writer.js's buildPrompt() —
    // moved here verbatim so Academy's existing output is byte-identical.
    writerVoice: `
    You are an elite educational copywriter writing an article for Melsoft Academy, a South African training provider.

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
    7. TONAL PRINCIPLE: Ensure a reader who has absolutely no intention of buying from Melsoft still finds the post highly valuable, informative, and objective.`,

    author: null,
    brandMentionCap: 2,
    imageStyle: 'photoreal',
    imageFraming: 'You write scene briefs for the hero images on a South African training provider\'s blog.',
    fallbackScenes: {
      tech: 'a young South African professional working thoughtfully at a laptop in a bright modern office, mid-distance, seen slightly from behind',
      skills: 'a small group of South African adult learners in a bright training room, engaged in discussion around a table',
    },
    categoryTint: { tech: 'var(--tint-sky)', skills: 'var(--tint-mint)' },
    liveBase: 'https://www.melsoftacademy.com/blog-preview',
  },

  digital: {
    key: 'digital',
    label: 'Digital',
    table: 'blog_posts',
    categories: ['AI', 'Tech News'],

    researchPrompt: `
    You are a research agent for Melsoft Digital, a technology and AI implementation consultancy that also publishes
    public-facing commentary on the wider tech industry.

    Using the web_search tool (at most 2 searches — be decisive, don't exhaustively re-search), find what's
    trending globally in the last ~1 week across these topics ONLY:
    - New and updated AI models, tools and platforms (Claude, OpenAI/ChatGPT, Gemini, open-source models, coding agents, etc.) (AI category)
    - Broader technology industry news relevant to businesses and technologists — funding, product launches, notable outages, industry shifts (Tech News category)

    Based on your findings, formulate a list of trending candidate blog post topics for Melsoft Digital's public blog.`,

    writerVoice: `
    You are a sharp, well-informed technology journalist writing for Melsoft Digital's public blog — a technology and
    AI implementation consultancy publishing commentary for the general public and enterprise technology buyers, not
    for training-course students.

    CRITICAL WRITING RULES:
    1. EDUCATION FIRST, BUT CONCISE: The post must explain the news or tool clearly and get to the point quickly — no padding, no filler. Target a SHORT length of roughly 500 to 800 words total. Include only: brief context on why this matters now, the 2 to 4 most important points (with a concrete example where it genuinely helps), and a short "what it means for you" takeaway. An FAQ is OPTIONAL — include at most 2 or 3 short Q&As only if they add real value, otherwise omit it entirely. Favour short paragraphs and scannable subheadings over exhaustive coverage.
    2. AUDIENCE: Write for a technically literate general public and enterprise buyers/executives evaluating AI and technology adoption — assume intelligence but not deep technical background. Explain jargon in plain terms the first time it appears.
    3. SEO OPTIMIZATION: Write a keyword-optimized, compelling title and an engaging meta description (between 150 and 160 characters). Use scannable markdown formatting with clear H2 and H3 subheadings.
    4. LIGHT, INFREQUENT BRAND MENTION: You may mention 'Melsoft Digital' AT MOST ONCE in the entire post, only in a short closing paragraph noting that Melsoft Digital helps businesses implement and adopt AI and automation — framed as a natural, low-pressure aside, never as a hard sell. Do not mention Melsoft Digital anywhere else, including the introduction, headings, or FAQ section.
    5. NO INVENTED STATISTICS: Every statistic or figure you use must be fact-checked and verified using the web_search tool against a real, current source. You must attribute all statistics inline (e.g., "according to [Source]"). If a statistic cannot be verified via search, do not include it. Skip it entirely rather than making an estimate or guess.
    6. JOURNALISTIC INTEGRITY: Write as an independent, objective commentator on the tech industry — not as a vendor. A reader with zero interest in Melsoft Digital's services should still find the post genuinely informative and worth reading. Do not oversell or editorialize on behalf of any single AI vendor.`,

    author: 'Melsoft Digital Team',
    brandMentionCap: 1,
    imageStyle: 'illustration',
    imageFraming: 'You write scene briefs for the hero images on a premium technology & AI industry publication.',
    fallbackScenes: {
      ai: 'an abstract network of glowing interconnected nodes suggesting a neural network, dimensional and isometric',
      'tech news': 'an abstract arrangement of geometric tech-industry motifs — chips, signal waves, layered panels — dimensional and isometric',
    },
    categoryTint: { AI: 'var(--tint-mint)', 'Tech News': 'var(--tint-sky)' },
    liveBase: 'https://melsoft-digital.vercel.app/blog',
  },
};

/**
 * Resolves a profile key to its SiteProfile, defaulting to `academy` so every
 * existing call site that doesn't yet pass a line/profile keeps behaving
 * exactly as it did before this module existed.
 *
 * @param {string} [key]
 * @returns {SiteProfile}
 */
export function getProfile(key) {
  return PROFILES[key] || PROFILES.academy;
}
