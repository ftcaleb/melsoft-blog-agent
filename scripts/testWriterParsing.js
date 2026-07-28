// Regression suite for the writer's response parsing and content gate.
//
// Zero API cost — every case is a synthetic Anthropic response shape. Run with:
//   node scripts/testWriterParsing.js
//
// Each case pins a real failure mode observed in production or measured against
// the live API while diagnosing the published-commentary incident.

import { parseWriterResponse, validatePost, PostValidationError, generateSlug } from '../src/writer.js';

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
// Fixtures
// ---------------------------------------------------------------------------

const words = (n, tag = 'word') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');

/** A realistic, compliant article body (~600 words). */
const GOOD_BODY = `## Why This Matters\n\n${words(280, 'alpha')}\n\n## What To Do Next\n\n${words(300, 'beta')}`;

const goodPost = (suffix = '') => ({
  title: `Why Excel Skills Still Matter in South Africa${suffix}`,
  metaDescription: 'Learn which Excel skills South African employers actually screen for, and how to build them in 2026.',
  bodyMarkdown: GOOD_BODY,
});

const textBlock = (text) => ({ type: 'text', text });
const searchBlocks = () => [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
];

// The model's out-loud self-review, verbatim in shape from the leaked page.
const SELF_REVIEW = `Wait, let me recount my Melsoft mentions and check for compliance with all rules: 1. Melsoft mentions: I see ZERO mentions of Melsoft in my response. Rule 4 says I should mention it AT MOST TWICE - once two-thirds through and once in closing. However, Rule 5 says if I mention Melsoft at all, I must refer to it as "QCTO-accredited". Let me verify all other rules: - Rule 1: Concise, ~550-750 words ✓ - Rule 9: No tables ✓ - Rule 10: No emoji ✓ Actually, I realize I should verify my word count is tighter. Let me refine:`;

const FINAL_CHECK = `Perfect. Let me do a final check:\n\nWord count: ~660 words ✓\nMelsoft mentions: 0 (acceptable, within "at most 2") ✓\nAll statistics cited ✓`;

console.log('\n--- writer response parsing ---');

check('clean single object in a single text block parses directly', () => {
  const result = parseWriterResponse([textBlock(JSON.stringify(goodPost()))]);
  assert(result, 'expected a result');
  assert(result.strategy === 'block[0]/json', `expected block[0]/json, got ${result.strategy}`);
  assert(result.post.bodyMarkdown === GOOD_BODY, 'body was altered');
});

check('THE INCIDENT: three drafts + self-review prose does not leak commentary', () => {
  const raw = [
    JSON.stringify(goodPost(' (2026)')),
    '',
    SELF_REVIEW,
    '```json',
    JSON.stringify(goodPost(' v2')),
    '```',
    '',
    FINAL_CHECK,
    JSON.stringify(goodPost(' v3')),
  ].join('\n');

  const result = parseWriterResponse([textBlock(raw)]);
  assert(result, 'expected a result');
  const body = result.post.bodyMarkdown;
  assert(!body.includes('Wait, let me recount'), 'self-review prose leaked into the body');
  assert(!body.includes('```json'), 'code fence leaked into the body');
  assert(!body.includes('"bodyMarkdown"'), 'raw JSON keys leaked into the body');
  assert(!body.includes('Perfect. Let me do a final check'), 'final-check prose leaked into the body');
  assert(body === GOOD_BODY, 'body is not the clean article');
  // Last complete draft is the model's final answer.
  assert(result.post.title.endsWith(' v3'), `expected the final draft, got: ${result.post.title}`);
  validatePost(result.post); // must not throw
});

check('THE MULTI-TURN BUG: two text blocks each holding a full object', () => {
  // Measured against the live API: with server-side web_search the request runs
  // several sampling turns, each emitting its own complete JSON object. Joining
  // them with '' yields {...}{...}, which can never parse.
  const content = [
    ...searchBlocks(),
    textBlock(JSON.stringify(goodPost(' turn one'))),
    ...searchBlocks(),
    textBlock(JSON.stringify(goodPost(' turn two'))),
  ];
  const result = parseWriterResponse(content);
  assert(result, 'expected a result — this is the case the old join("") could never parse');
  assert(result.post.title.endsWith(' turn two'), `expected the final turn, got: ${result.post.title}`);
  validatePost(result.post);
});

check('leading whitespace before the object (observed live) still parses', () => {
  const result = parseWriterResponse([textBlock(`\n\n ${JSON.stringify(goodPost())}`)]);
  assert(result && result.post.bodyMarkdown === GOOD_BODY, 'whitespace-prefixed object failed');
});

check('jsonrepair array coercion cannot produce an empty post', () => {
  // Two bare objects separated by prose: jsonrepair wraps this into an ARRAY,
  // whose .title/.bodyMarkdown are undefined. Accepting it previously published
  // a draft with the topic title and a completely empty body.
  const raw = `${JSON.stringify(goodPost(' one'))}\n\nsome stray narration\n\n${JSON.stringify(goodPost(' two'))}`;
  const result = parseWriterResponse([textBlock(raw)]);
  assert(result, 'expected a result');
  assert(result.post.bodyMarkdown.length > 0, 'recovered an EMPTY body');
  assert(!Array.isArray(result.post), 'returned an array');
  validatePost(result.post);
});

check('truncated final draft falls back to the last complete one', () => {
  const truncated = JSON.stringify(goodPost(' cut')).slice(0, -40);
  const raw = `${JSON.stringify(goodPost(' complete'))}\n\n${truncated}`;
  const result = parseWriterResponse([textBlock(raw)]);
  assert(result, 'expected a result');
  assert(result.post.title.endsWith(' complete'), `expected the complete draft, got: ${result.post.title}`);
  validatePost(result.post);
});

check('unescaped double quote in the body recovers a bounded value', () => {
  // Invalid JSON: a raw " inside bodyMarkdown. The lenient path must stop at the
  // object's own closing brace, not run to the end of the response.
  const raw = `{"title":"Bounded Recovery Test","metaDescription":"meta","bodyMarkdown":"## Heading\\n\\n${words(400, 'gamma')} he said "hello" and continued"}`;
  const result = parseWriterResponse([textBlock(raw)]);
  assert(result, 'expected a result');
  assert(!result.post.bodyMarkdown.includes('"title"'), 'recovery ran past the object boundary');
  assert(result.post.title === 'Bounded Recovery Test', `title wrong: ${result.post.title}`);
});

check('no text blocks returns null rather than a fabricated post', () => {
  assert(parseWriterResponse(searchBlocks()) === null, 'expected null');
  assert(parseWriterResponse([]) === null, 'expected null');
  assert(parseWriterResponse(undefined) === null, 'expected null');
});

check('prose-only response returns null', () => {
  assert(parseWriterResponse([textBlock('I was unable to complete this task.')]) === null, 'expected null');
});

console.log('\n--- validatePost content gate ---');

const expectRejection = (name, post, expectedFragment) => {
  check(name, () => {
    let thrown = null;
    try {
      validatePost(post);
    } catch (err) {
      thrown = err;
    }
    assert(thrown, 'validatePost did NOT throw');
    assert(thrown instanceof PostValidationError, `wrong error type: ${thrown.name}`);
    assert(
      thrown.reasons.some((r) => r.includes(expectedFragment)),
      `expected a reason containing "${expectedFragment}", got: ${JSON.stringify(thrown.reasons)}`
    );
  });
};

check('a compliant post passes', () => {
  validatePost(goodPost());
});

expectRejection('empty body is rejected', { ...goodPost(), bodyMarkdown: '' }, 'usable title');
expectRejection('missing title is rejected', { ...goodPost(), title: '   ' }, 'usable title');
expectRejection(
  'body of duplicated drafts is rejected on word count',
  { ...goodPost(), bodyMarkdown: words(2335, 'bloat') },
  'max 1400'
);
expectRejection('stub body is rejected on word count', { ...goodPost(), bodyMarkdown: 'Too short.' }, 'min 300');
expectRejection(
  'leaked self-review commentary is rejected',
  { ...goodPost(), bodyMarkdown: `${GOOD_BODY}\n\n${SELF_REVIEW}` },
  'self-review commentary'
);
expectRejection(
  'leaked raw JSON keys are rejected',
  { ...goodPost(), bodyMarkdown: `${GOOD_BODY}\n\n{"bodyMarkdown": "## Another draft"}` },
  'raw JSON key'
);
expectRejection(
  'leaked ```json fence is rejected',
  { ...goodPost(), bodyMarkdown: `${GOOD_BODY}\n\n\`\`\`json\n{"x":1}` },
  'code fence'
);
expectRejection(
  'checklist tick marks are rejected',
  { ...goodPost(), bodyMarkdown: `${GOOD_BODY}\n\nWord count: ~660 words ✓` },
  'tick mark'
);
expectRejection(
  'rule-compliance checklist is rejected',
  { ...goodPost(), bodyMarkdown: `${GOOD_BODY}\n\n- Rule 1: Concise` },
  'checklist'
);
expectRejection(
  'surviving cite tags are rejected',
  { ...goodPost(), bodyMarkdown: `${GOOD_BODY}\n\n<cite index="1">source</cite>` },
  'internal tag'
);
expectRejection(
  'a body that is itself a JSON object is rejected',
  { ...goodPost(), bodyMarkdown: `{"title":"x"}\n\n${words(400, 'delta')}` },
  'JSON object'
);
expectRejection(
  'an absurdly long title is rejected',
  { ...goodPost(), title: words(60, 'longtitle') },
  'max 200'
);

console.log('\n--- unchanged behaviour (guard against regressions) ---');

check('generateSlug is unchanged', () => {
  assert(
    generateSlug("A Beginner's Guide to Data Science in SA") === 'a-beginners-guide-to-data-science-in-sa',
    'slug generation changed'
  );
  assert(generateSlug('') === '', 'empty title should yield an empty slug');
});

check('a legitimate 800-word post at the target ceiling passes', () => {
  validatePost({ ...goodPost(), bodyMarkdown: `## Heading\n\n${words(800, 'legit')}` });
});

check('a legitimate post mentioning statistics and sources passes', () => {
  validatePost({
    ...goodPost(),
    bodyMarkdown: `## The Numbers\n\nAccording to Stats SA, the rate rose. ${words(400, 'eps')}\n\n## Frequently Asked Questions\n\n### Is it worth it?\n\n${words(60, 'zeta')}`,
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
