// Regression suite for the OpenAI text-provider port.
//
// Zero API cost — every case is a synthetic payload whose shape was RECORDED
// from the live Responses API before the port was written. Run with:
//   node scripts/testOpenAIProvider.js
//
// Two things are pinned here:
//   1. normaliseOpenAIResponse() — the adapter that lets OpenAI payloads flow
//      through the Anthropic-shaped parser built after the 2026-07-27 incident.
//      This mapping is the highest-risk part of the port.
//   2. The citation guard — OpenAI's hosted web search attributes sources as
//      inline markdown links on every model tier measured, which the prompt
//      forbids outright and validatePost previously did not catch.

import { normaliseOpenAIResponse } from '../src/textProvider.js';
import {
  parseWriterResponse,
  validatePost,
  stripCitationLinks,
  PostValidationError,
} from '../src/writer.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fixtures — shapes recorded from the live OpenAI Responses API
// ---------------------------------------------------------------------------

const words = (n, tag = 'word') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
const GOOD_BODY = `## Why This Matters\n\n${words(280, 'alpha')}\n\n## What To Do Next\n\n${words(300, 'beta')}`;

const goodPostJson = () => JSON.stringify({
  title: 'AI Coding Agents in 2026: What Developers Need to Know',
  metaDescription: 'What AI coding agents do well in 2026, where autonomy breaks down, and how to evaluate them.',
  bodyMarkdown: GOOD_BODY,
});

const message = (text, annotations = []) => ({
  type: 'message',
  content: [{ type: 'output_text', text, annotations }],
});

/** The exact item sequence measured for gpt-6-astra with web search enabled. */
const withSearch = (text) => ({
  status: 'completed',
  incomplete_details: null,
  output: [
    { type: 'web_search_call', id: 'ws_1' },
    { type: 'web_search_call', id: 'ws_2' },
    { type: 'reasoning', id: 'rs_1' },
    message(text, [{ type: 'url_citation', url: 'https://example.com' }]),
  ],
  usage: {
    input_tokens: 30500,
    output_tokens: 1356,
    input_tokens_details: { cached_tokens: 4408, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 239 },
  },
});

console.log('\n--- OpenAI response adapter ---');

check('the recorded web-search shape yields exactly one usable text block', () => {
  const r = normaliseOpenAIResponse(withSearch(goodPostJson()));
  assert(r.content.length === 1, `expected 1 text block, got ${r.content.length}`);
  assert(r.content[0].type === 'text', 'block must be normalised to type "text"');
  assert(r.stop_reason === 'completed', `unexpected stop_reason ${r.stop_reason}`);
});

check('web_search_call items are counted, never treated as text', () => {
  const r = normaliseOpenAIResponse(withSearch(goodPostJson()));
  assert(r.usage.webSearches === 2, `expected 2 searches, got ${r.usage.webSearches}`);
  assert(!r.content.some((b) => /web_search/.test(b.text)), 'search items must not leak into text');
});

check('reasoning tokens are surfaced (OpenAI bills them as output)', () => {
  const r = normaliseOpenAIResponse(withSearch(goodPostJson()));
  assert(r.usage.reasoningTokens === 239, `expected 239 reasoning tokens, got ${r.usage.reasoningTokens}`);
  assert(r.usage.cacheRead === 4408, `expected 4408 cached, got ${r.usage.cacheRead}`);
});

check('truncation maps to the stop_reason the callers already guard on', () => {
  const r = normaliseOpenAIResponse({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [message('{"title":"x"')],
    usage: {},
  });
  assert(r.stop_reason === 'max_tokens', `expected max_tokens, got ${r.stop_reason}`);
});

check('an empty/garbage payload degrades to no blocks rather than throwing', () => {
  for (const bad of [null, {}, { output: null }, { output: [] }, { output: [{ type: 'reasoning' }] }]) {
    const r = normaliseOpenAIResponse(bad);
    assert(Array.isArray(r.content) && r.content.length === 0, 'expected zero blocks');
  }
});

check('THE INTEGRATION POINT: an OpenAI payload parses through the Anthropic parser', () => {
  const r = normaliseOpenAIResponse(withSearch(goodPostJson()));
  const parsed = parseWriterResponse(r.content);
  assert(parsed, 'parseWriterResponse returned null on a valid OpenAI payload');
  assert(parsed.post.title.startsWith('AI Coding Agents'), 'wrong title recovered');
  assert(parsed.strategy.endsWith('/json'), `expected a clean JSON parse, got ${parsed.strategy}`);
});

check('a multi-message payload takes the LAST message (latest wins)', () => {
  const r = normaliseOpenAIResponse({
    status: 'completed',
    output: [message('{"title":"stale"}'), { type: 'reasoning' }, message(goodPostJson())],
    usage: {},
  });
  const parsed = parseWriterResponse(r.content);
  assert(parsed.post.title.startsWith('AI Coding Agents'), 'must prefer the newest message');
});

console.log('\n--- citation guard (the defect the live probe exposed) ---');

check('parenthesised citation links are flattened to plain text', () => {
  const out = stripCitationLinks('Agents open PRs. ([docs.github.com](https://docs.github.com/en/copilot))');
  assert(out === 'Agents open PRs. (docs.github.com)', `got: ${out}`);
});

check('bare inline links keep their label and lose the URL', () => {
  const out = stripCitationLinks('according to [Stats SA](https://statssa.gov.za) the rate rose');
  assert(out === 'according to Stats SA the rate rose', `got: ${out}`);
});

check('attribution survives sanitising — the prompt wants the source named', () => {
  const out = stripCitationLinks('([Artificial Analysis](https://artificialanalysis.ai/x))');
  assert(/Artificial Analysis/.test(out), 'source name must be preserved');
  assert(!/https?:\/\//.test(out), 'URL must be gone');
});

check('prose without links is left byte-identical', () => {
  const clean = '## Heading\n\nPlain prose with (parentheses) and [brackets] but no links.';
  assert(stripCitationLinks(clean) === clean, 'sanitiser must not disturb clean prose');
});

check('THE REAL CASE: measured OpenAI output passes the gate after sanitising', () => {
  const withCitation = `## Coding agents\n\n${words(280, 'alpha')} ([docs.github.com](https://docs.github.com/x))\n\n## Next\n\n${words(300, 'beta')}`;
  // Before sanitising the gate must reject it...
  let rejected = false;
  try {
    validatePost({ title: 'T', metaDescription: 'm', bodyMarkdown: withCitation });
  } catch (err) {
    rejected = err instanceof PostValidationError && /hyperlink/.test(err.message);
  }
  assert(rejected, 'an un-sanitised citation link must be rejected by the gate');
  // ...and after sanitising it must pass.
  validatePost({ title: 'T', metaDescription: 'm', bodyMarkdown: stripCitationLinks(withCitation) });
});

check('link forms the sanitiser does not handle are still blocked', () => {
  const cases = [
    [`${words(400, 'a')} [see docs][ref1]`, 'reference-style'],
    [`${words(400, 'a')} <a href="https://x.com">x</a>`, 'raw HTML'],
  ];
  for (const [body, label] of cases) {
    let rejected = false;
    try {
      validatePost({ title: 'T', metaDescription: 'm', bodyMarkdown: body });
    } catch (err) {
      rejected = err instanceof PostValidationError;
    }
    assert(rejected, `${label} link must be rejected`);
  }
});

check('the incident signatures still fire (guard not weakened by the port)', () => {
  const leaked = `${words(400, 'a')}\n\nWait, let me recount my Melsoft mentions. Rule 1: ✓\n\`\`\`json\n{"bodyMarkdown": "..."}`;
  let reasons = [];
  try {
    validatePost({ title: 'T', metaDescription: 'm', bodyMarkdown: leaked });
  } catch (err) {
    reasons = err.reasons || [];
  }
  assert(reasons.length >= 3, `expected multiple independent reasons, got ${reasons.length}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
