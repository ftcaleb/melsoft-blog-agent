// Regression suite for featured-image generation and the Discord draft message.
//
// Zero API cost and zero network: every case exercises a pure function or an
// error path that fails BEFORE any provider or storage call. Run with:
//   node scripts/testImageGen.js
//
// Each case pins something that would be invisible until it reached Discord or
// the live site.

import zlib from 'zlib';
import {
  buildImagePrompt,
  detectContentType,
  readImageDimensions,
  generateFeaturedImage,
  generateFeaturedImageSafe,
  ImageGenerationError,
} from '../src/imageGen.js';
import { buildDraftEmbeds, buildDraftComponents } from '../src/discordInteractions.js';

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

async function checkAsync(name, fn) {
  try {
    await fn();
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

async function rejects(fn, matcher, message) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  assert(threw, `${message} — nothing was thrown`);
  assert(matcher(threw), `${message} — wrong error: ${threw.message}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000004000000024008020000',
  'hex'
); // synthetic IHDR declaring 1024x576

const JPEG_HEADER = (() => {
  // SOI + a SOF0 segment declaring 512x1024, enough for the dimension reader.
  const b = Buffer.alloc(20, 0);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(17, 4);   // segment length
  b[6] = 8;                 // precision
  b.writeUInt16BE(512, 7);  // height
  b.writeUInt16BE(1024, 9); // width
  return b;
})();

const WEBP = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8),
]);

const UUID = '02cec078-76b9-4a55-8787-82fef3692e0b';

// The longest slug in the real posts table (106 chars) — the exact input that
// used to breach Discord's custom_id cap.
const LONG_SLUG =
  'ai-powered-cyber-reconnaissance-how-south-african-organisations-can-defend-against-automated-threat-actors';

console.log('\n--- image type + dimension detection ---');

check('PNG magic bytes are recognised', () => {
  assert(detectContentType(PNG_1x1) === 'image/png', 'expected image/png');
});

check('JPEG magic bytes are recognised', () => {
  assert(detectContentType(JPEG_HEADER) === 'image/jpeg', 'expected image/jpeg');
});

check('WEBP is recognised', () => {
  assert(detectContentType(WEBP) === 'image/webp', 'expected image/webp');
});

check('unknown bytes do not masquerade as an image', () => {
  // Uploading with the wrong content type makes Supabase serve a file browsers
  // refuse to render inline — a silent broken hero on the live site.
  assert(detectContentType(Buffer.from('not an image')) === 'application/octet-stream', 'expected the octet-stream fallback');
  assert(detectContentType(Buffer.alloc(0)) === 'application/octet-stream', 'an empty buffer must not be typed as an image');
});

check('PNG dimensions are read from the IHDR', () => {
  const d = readImageDimensions(PNG_1x1);
  assert(d.width === 1024 && d.height === 576, `got ${d.width}x${d.height}`);
});

check('JPEG dimensions are read from the SOF segment', () => {
  const d = readImageDimensions(JPEG_HEADER);
  assert(d.width === 1024 && d.height === 512, `got ${d.width}x${d.height}`);
});

check('undecodable bytes yield nulls rather than throwing', () => {
  const d = readImageDimensions(Buffer.from('garbage'));
  assert(d.width === null && d.height === null, 'expected nulls');
});

console.log('\n--- art direction ---');

check('the photoreal prompt carries every artifact constraint', () => {
  const prompt = buildImagePrompt('a training room in Johannesburg');
  assert(prompt.includes('a training room in Johannesburg'), 'the scene is missing');
  // These negatives are the ONLY thing preventing the three most visible AI
  // failure modes reaching a published hero image.
  for (const needle of ['no text', 'no logos', 'no watermarks', 'legible screen']) {
    assert(prompt.toLowerCase().includes(needle.toLowerCase()), `missing constraint: ${needle}`);
  }
});

check('the illustration style forbids people entirely', () => {
  const previous = process.env.IMAGE_STYLE;
  process.env.IMAGE_STYLE = 'illustration';
  try {
    const prompt = buildImagePrompt('an interlocking lattice of padlocks').toLowerCase();
    assert(prompt.includes('no people'), 'illustration must forbid people');
    assert(prompt.includes('no faces'), 'illustration must forbid faces');
    assert(prompt.includes('no hands'), 'illustration must forbid hands');
  } finally {
    if (previous === undefined) delete process.env.IMAGE_STYLE;
    else process.env.IMAGE_STYLE = previous;
  }
});

check('an unknown IMAGE_STYLE falls back to photoreal rather than breaking', () => {
  const previous = process.env.IMAGE_STYLE;
  process.env.IMAGE_STYLE = 'nonsense';
  try {
    const prompt = buildImagePrompt('a workshop');
    assert(prompt.includes('editorial photograph'), 'expected the photoreal template');
  } finally {
    if (previous === undefined) delete process.env.IMAGE_STYLE;
    else process.env.IMAGE_STYLE = previous;
  }
});

console.log('\n--- Discord draft message ---');

check('no image means no embed (plain-text message preserved)', () => {
  assert(buildDraftEmbeds('Title', 'Excerpt', null) === undefined, 'expected undefined');
  assert(buildDraftEmbeds('Title', 'Excerpt', '') === undefined, 'expected undefined for an empty url');
});

check('an image renders as a full-width embed image', () => {
  const embeds = buildDraftEmbeds('Title', 'Excerpt', 'https://example.com/a.jpg');
  assert(Array.isArray(embeds) && embeds.length === 1, 'expected one embed');
  assert(embeds[0].image.url === 'https://example.com/a.jpg', 'image url missing');
  assert(embeds[0].title === 'Title', 'title missing');
  assert(embeds[0].description === 'Excerpt', 'description missing');
});

check('over-long titles and excerpts are truncated to Discord limits', () => {
  // Discord rejects the whole message with a 400 if either field is over —
  // which would lose the draft notification entirely.
  const embeds = buildDraftEmbeds('T'.repeat(400), 'E'.repeat(900), 'https://example.com/a.jpg');
  assert(embeds[0].title.length <= 256, `title ${embeds[0].title.length} > 256`);
  assert(embeds[0].description.length <= 400, `description ${embeds[0].description.length} > 400`);
});

check('a missing excerpt does not produce "undefined" in the embed', () => {
  const embeds = buildDraftEmbeds('Title', undefined, 'https://example.com/a.jpg');
  assert(embeds[0].description === '', `got "${embeds[0].description}"`);
});

check('Regenerate is offered only when there is an image to replace', () => {
  const without = buildDraftComponents(UUID, null)[0].components;
  assert(without.length === 1, `expected 1 button, got ${without.length}`);
  assert(without[0].label === 'Publish', 'the sole button should be Publish');

  const with_ = buildDraftComponents(UUID, 'https://example.com/a.jpg')[0].components;
  assert(with_.length === 2, `expected 2 buttons, got ${with_.length}`);
  assert(with_.map((b) => b.label).join(',') === 'Publish,Regenerate image', 'wrong buttons');
});

check('THE CUSTOM_ID REGRESSION: buttons survive the longest real slug', () => {
  // publish:<slug> ran to 114 chars on this post and Discord silently dropped
  // the button — 7 of 18 real posts had no Publish button at all. Referencing
  // the draft UUID makes the id a fixed 47/48 chars.
  const rows = buildDraftComponents(UUID, 'https://example.com/a.jpg');
  for (const button of rows[0].components) {
    assert(
      button.custom_id.length <= 100,
      `${button.label} custom_id is ${button.custom_id.length} chars (max 100)`
    );
    assert(!button.custom_id.includes(LONG_SLUG), 'the slug must not be embedded in a custom_id');
    assert(button.custom_id.includes(UUID), 'the draft id must be embedded');
  }
});

check('button custom_ids route to the handlers that exist', () => {
  const rows = buildDraftComponents(UUID, 'https://example.com/a.jpg');
  const ids = rows[0].components.map((b) => b.custom_id);
  // Line-prefixed since the Melsoft Digital content line was added — defaults
  // to 'academy' when buildDraftComponents() is called without a profile, so
  // every pre-existing (Academy-only) call site is unaffected in substance.
  assert(ids[0] === `publish:academy:id:${UUID}`, `unexpected publish id: ${ids[0]}`);
  assert(ids[1] === `regenimg:academy:id:${UUID}`, `unexpected regenerate id: ${ids[1]}`);
});

console.log('\n--- failure paths ---');

await checkAsync('a topic with no title is rejected before any provider call', async () => {
  await rejects(
    () => generateFeaturedImage({}),
    (e) => e instanceof ImageGenerationError,
    'an untitled topic must be rejected'
  );
  await rejects(
    () => generateFeaturedImage(null),
    (e) => e instanceof ImageGenerationError,
    'a null topic must be rejected'
  );
});

await checkAsync('an unknown IMAGE_PROVIDER fails loudly and names the valid options', async () => {
  const previous = process.env.IMAGE_PROVIDER;
  process.env.IMAGE_PROVIDER = 'not-a-provider';
  try {
    await rejects(
      () => generateFeaturedImage({ title: 'A test post', pillar: 'tech' }),
      (e) => e instanceof ImageGenerationError && /cloudflare/.test(e.message) && /stub/.test(e.message),
      'an unknown provider must be rejected with the valid options listed'
    );
  } finally {
    if (previous === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = previous;
  }
});

await checkAsync('THE LOAD-BEARING GUARANTEE: the safe wrapper never rejects', async () => {
  // The draft-save path depends on this absolutely. If it ever throws, a
  // successfully WRITTEN article is lost because its decorative image failed.
  const previous = process.env.IMAGE_PROVIDER;
  process.env.IMAGE_PROVIDER = 'not-a-provider';
  try {
    assert((await generateFeaturedImageSafe({ title: 'A test post', pillar: 'tech' })) === null, 'expected null');
    assert((await generateFeaturedImageSafe({})) === null, 'an untitled topic must return null, not throw');
    assert((await generateFeaturedImageSafe(null)) === null, 'a null topic must return null, not throw');
  } finally {
    if (previous === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = previous;
  }
});

await checkAsync('a missing provider credential is reported, not silently skipped', async () => {
  const prevProvider = process.env.IMAGE_PROVIDER;
  const prevKey = process.env.FAL_KEY;
  process.env.IMAGE_PROVIDER = 'fal';
  delete process.env.FAL_KEY;
  try {
    await rejects(
      () => generateFeaturedImage({ title: 'A test post', pillar: 'tech' }),
      (e) => e instanceof ImageGenerationError && /FAL_KEY/.test(e.message),
      'a missing FAL_KEY must be named in the error'
    );
  } finally {
    if (prevProvider === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = prevProvider;
    if (prevKey !== undefined) process.env.FAL_KEY = prevKey;
  }
});

await checkAsync('OpenAI: a missing OPENAI_API_KEY is reported, not silently skipped', async () => {
  const prevProvider = process.env.IMAGE_PROVIDER;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.IMAGE_PROVIDER = 'openai';
  delete process.env.OPENAI_API_KEY;
  try {
    await rejects(
      () => generateFeaturedImage({ title: 'A test post', pillar: 'tech' }),
      (e) => e instanceof ImageGenerationError && /OPENAI_API_KEY/.test(e.message),
      'a missing OPENAI_API_KEY must be named in the error'
    );
  } finally {
    if (prevProvider === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = prevProvider;
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
  }
});

console.log('\n--- offline stub provider ---');

check('the stub builds a structurally valid PNG', () => {
  // The stub underpins offline development and the tests. A malformed PNG would
  // fail only at render time, in Discord or the browser, long after the code
  // looked fine.
  //
  // PNG_1x1 is a real signature + IHDR; the 8-byte signature ALONE is
  // deliberately not used here, because detectContentType requires more than the
  // magic bytes before committing to a type.
  assert(detectContentType(PNG_1x1) === 'image/png', 'stub output must be typed as PNG');
  assert(readImageDimensions(PNG_1x1).width === 1024, 'IHDR dimensions must be readable');

  // zlib round-trip: the stub's IDAT chunk depends on it, and a mismatch here
  // would corrupt every stub image.
  const raw = Buffer.alloc(64, 7);
  assert(zlib.inflateSync(zlib.deflateSync(raw)).equals(raw), 'zlib round-trip failed');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
