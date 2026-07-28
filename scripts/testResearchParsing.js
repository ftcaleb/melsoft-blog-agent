// Regression suite for the research agent's response parsing.
//
// Zero API cost. Run with:  node scripts/testResearchParsing.js
//
// Pins the same failure class the writer had: with the server-side web_search
// tool the API runs several sampling turns, each emitting its own text block, so
// a request can return two complete JSON lists. The old code joined them with ''
// and took a greedy indexOf('[')..lastIndexOf(']') span, which jsonrepair then
// coerced into an ARRAY OF ARRAYS whose elements all had title === undefined —
// and that poisoned batch was persisted to the research_cache row.

import { parseCandidatesResponse } from '../src/research.js';

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

const candidate = (n, pillar = 'tech') => ({
  title: `A Genuinely Trending South African Topic Number ${n}`,
  pitch: 'What it means and what to do about it.',
  pillar,
  type: 'recent',
  sourceNotes: 'https://example.co.za/article',
});

const envelope = (items) => JSON.stringify({ candidates: items });
const bareArray = (items) => JSON.stringify(items);
const textBlock = (text) => ({ type: 'text', text });
const searchBlocks = () => [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
];

const titles = (list) => list.map((c) => c.title);

console.log('\n--- research response parsing ---');

check('the { candidates: [...] } envelope parses', () => {
  const out = parseCandidatesResponse([textBlock(envelope([candidate(1), candidate(2, 'skills')]))]);
  assert(out.length === 2, `expected 2, got ${out.length}`);
  assert(out[0].pillar === 'tech' && out[1].pillar === 'skills', 'pillars wrong');
});

check('a bare [...] array still parses (legacy / unconstrained fallback shape)', () => {
  const out = parseCandidatesResponse([textBlock(bareArray([candidate(1), candidate(2)]))]);
  assert(out.length === 2, `expected 2, got ${out.length}`);
});

check('THE MULTI-TURN BUG: two lists in two text blocks', () => {
  const content = [
    ...searchBlocks(),
    textBlock(envelope([candidate(1)])),
    ...searchBlocks(),
    textBlock(envelope([candidate(2), candidate(3)])),
  ];
  const out = parseCandidatesResponse(content);
  assert(out.length === 2, `expected the final turn's 2 candidates, got ${out.length}`);
  assert(
    titles(out).every((t) => !t.includes('Number 1')),
    'returned the superseded first-turn list'
  );
  assert(out.every((c) => typeof c.title === 'string' && c.title.length > 8), 'undefined titles leaked through');
});

check('two concatenated lists in ONE block never yield undefined titles', () => {
  // The exact array-of-arrays shape jsonrepair produced. Every candidate must
  // have a real title — "undefined" topic names were the user-visible symptom.
  const raw = `${bareArray([candidate(1)])}\n\nLet me refine that list:\n\n${bareArray([candidate(2)])}`;
  const out = parseCandidatesResponse([textBlock(raw)]);
  assert(out.length >= 1, 'recovered nothing');
  assert(out.every((c) => typeof c.title === 'string' && c.title.length > 8), `undefined titles: ${JSON.stringify(titles(out))}`);
  assert(out.every((c) => !Array.isArray(c)), 'an element is an array');
});

check('self-review commentary around the list is discarded', () => {
  const raw = [
    envelope([candidate(1)]),
    '',
    'Wait, let me recount — Rule 2 says return only a JSON array ✓',
    '```json',
    envelope([candidate(2), candidate(3)]),
    '```',
  ].join('\n');
  const out = parseCandidatesResponse([textBlock(raw)]);
  assert(out.length === 2, `expected 2, got ${out.length}`);
  assert(
    out.every((c) => !/wait|rule 2|✓|```/i.test(JSON.stringify(c))),
    'commentary leaked into a candidate'
  );
});

check('truncated final list falls back to the last complete one', () => {
  const raw = `${envelope([candidate(1)])}\n\n${envelope([candidate(2)]).slice(0, -25)}`;
  const out = parseCandidatesResponse([textBlock(raw)]);
  assert(out.length === 1, `expected 1, got ${out.length}`);
  assert(out[0].title.includes('Number 1'), `wrong list recovered: ${out[0].title}`);
});

check('brackets inside string values do not break depth tracking', () => {
  const tricky = envelope([{ ...candidate(1), pitch: 'Covers [brackets] and {braces} in prose' }]);
  const out = parseCandidatesResponse([textBlock(tricky)]);
  assert(out.length === 1, `expected 1, got ${out.length}`);
  assert(out[0].pitch.includes('[brackets]'), 'pitch was mangled');
});

console.log('\n--- candidate validation ---');

check('candidates without a usable title are dropped, not returned', () => {
  const out = parseCandidatesResponse([
    textBlock(envelope([candidate(1), { pitch: 'no title', pillar: 'tech', type: 'recent', sourceNotes: '' }])),
  ]);
  assert(out.length === 1, `expected the bad entry to be dropped, got ${out.length}`);
});

check('candidates with an unroutable pillar are dropped', () => {
  const out = parseCandidatesResponse([
    textBlock(envelope([candidate(1), { ...candidate(2), pillar: 'nonsense' }])),
  ]);
  assert(out.length === 1, `expected 1, got ${out.length}`);
});

check('pillar casing is normalized rather than rejected', () => {
  const out = parseCandidatesResponse([textBlock(envelope([{ ...candidate(1), pillar: 'Tech' }]))]);
  assert(out.length === 1, 'a capitalised pillar was wrongly rejected');
  assert(out[0].pillar === 'tech', `expected normalized 'tech', got ${out[0].pillar}`);
});

check('a missing type defaults to "recent"', () => {
  const { type, ...noType } = candidate(1);
  const out = parseCandidatesResponse([textBlock(envelope([noType]))]);
  assert(out.length === 1 && out[0].type === 'recent', `expected type 'recent', got ${out[0] && out[0].type}`);
});

check('nothing parseable returns an empty array (caller then throws, cache preserved)', () => {
  assert(parseCandidatesResponse([textBlock('I could not find anything.')]).length === 0, 'expected 0');
  assert(parseCandidatesResponse(searchBlocks()).length === 0, 'expected 0');
  assert(parseCandidatesResponse([]).length === 0, 'expected 0');
  assert(parseCandidatesResponse(undefined).length === 0, 'expected 0');
});

check('an empty candidates array returns empty rather than a bogus entry', () => {
  assert(parseCandidatesResponse([textBlock(envelope([]))]).length === 0, 'expected 0');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
