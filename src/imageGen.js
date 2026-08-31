// Deliverable: featured-image generation.
//
// Produces the hero image for a post and returns a PERMANENT public URL, ready
// to store in posts.image — the same column and the same `blog-images` bucket
// the dashboard's manual uploader already writes to, so Discord, the dashboard
// and the live site all read one identical URL.
//
// PROVIDER-SWITCHABLE. The generation call is the only provider-specific part;
// prompt building, download and upload are shared. Set IMAGE_PROVIDER to pick:
//
//   cloudflare  Workers AI FLUX.2 [dev]  — free daily allocation, slow (~100s).
//               Used for development so nothing is billed before the pipeline
//               is proven.
//   gemini      Gemini image models (Nano Banana) — matches the images already
//               published on the blog. Requires billing on the Google Cloud
//               project behind GEMINI_API_KEY (the free tier is a hard zero).
//   fal         fal.ai FLUX.2 [pro].
//   openai      OpenAI GPT Image (gpt-image-2 by default). Requires the
//               OpenAI ORGANIZATION (not just the API key) to complete API
//               Organization Verification in the OpenAI dashboard first —
//               every request 403s until that's done. Billing must be
//               enabled; there is no free tier for image generation. Note:
//               DALL-E 2/3 were retired from the API on 2026-05-12 — this
//               provider targets the GPT Image family that replaced them.
//   stub        A locally-generated placeholder. No network, no cost — lets the
//               tests and offline development exercise every downstream path.
//
// WHY THE UPLOAD MATTERS: fal and Gemini hand back CDN URLs that expire (fal's
// after ~7 days). Storing one of those directly would silently break every
// published post's hero a week later, so the bytes are always copied into
// Supabase Storage and it is that URL which is persisted.
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from './supabaseClient.js';
import { generateSlug } from './writer.js';
import { logAnthropicUsage } from './usage.js';
import { getProfile } from './profiles.js';

dotenv.config();

// Bucket the dashboard uploader already uses. Confirmed public.
const STORAGE_BUCKET = 'blog-images';

// Generated images live under their own prefix so they are trivially
// distinguishable from files a human uploaded through the dashboard.
const STORAGE_PREFIX = 'generated';

// Configuration is read at CALL time, not module load. Two reasons: an env
// change takes effect without redeploying this module's import graph (matching
// how isAuthorized() re-reads its allow-list), and the tests can exercise each
// provider without re-importing. The cost is a few env lookups per image, which
// is nothing next to a network round trip.
//
// Production targets 16:9, matching the two most recent published posts
// (2752x1536). Development deliberately uses a cheaper shape: Workers AI bills
// per 512x512 tile per step, so 1024x512 costs two tiles where 1024x576 costs
// four — halving the burn against the free daily allocation while testing,
// where the exact ratio is irrelevant.
const imageWidth = () => Number(process.env.IMAGE_WIDTH || 1024);
const imageHeight = () => Number(process.env.IMAGE_HEIGHT || 576);
const provider = () => (process.env.IMAGE_PROVIDER || 'cloudflare').toLowerCase();
// IMAGE_STYLE, if set, overrides EVERY line's style process-wide (useful for
// forcing one style during manual testing). Unset, each line falls back to
// its own profile default — Academy stays photoreal, Digital defaults to
// illustration, with no env change required.
const style = (profile) => (process.env.IMAGE_STYLE || (profile && profile.imageStyle) || 'photoreal').toLowerCase();

/**
 * Thrown when image generation fails. Callers on the draft-save path should use
 * generateFeaturedImageSafe() instead, which converts this to a null result — a
 * missing image must never cost you a written post.
 */
export class ImageGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

// ---------------------------------------------------------------------------
// Art direction
//
// The house style is FIXED here and only the scene/subject varies per post.
// That division is deliberate: it is what keeps a hundred posts looking like one
// publication instead of a hundred unrelated images. The model is never allowed
// to choose lighting, palette or composition.
// ---------------------------------------------------------------------------

const STYLE_TEMPLATES = {
  // Matches the images already published on the blog — warm, photographic,
  // authentically South African.
  photoreal: (scene) =>
    [
      'Professional editorial photograph for a South African education and technology blog.',
      `Scene: ${scene}`,
      'Shot on a full-frame camera with a 35mm lens, natural window light, shallow depth of field,',
      'warm authentic colour grading, candid documentary style, unmistakably South African setting.',
      'Composition: subject slightly off-centre with clean negative space, magazine editorial quality.',
      'Absolutely no text, no lettering, no signage, no logos, no watermarks, no user interface elements.',
      'Avoid close-up hands on keyboards and avoid any legible screen content.',
    ].join(' '),

  // Alternative brand-art direction: non-photographic, zero people, strongest
  // brand recognition. Kept available behind IMAGE_STYLE=illustration.
  illustration: (scene) =>
    [
      'Editorial conceptual illustration for a technology article.',
      `Subject: ${scene}`,
      'Positioned centre-right with generous negative space to the left.',
      'Art direction: deep plum to near-black navy gradient background, a single warm orange key light',
      'as the focal glow, violet rim lighting. Dimensional isometric forms with real volume and weight,',
      'soft cinematic studio lighting, shallow depth of field, subtle film grain, premium magazine quality.',
      'Absolutely no text, no letters, no words, no logos, no people, no faces, no hands.',
    ].join(' '),
};

/**
 * Looks up the offline fallback scene for a topic's pillar/category under a
 * profile's fallbackScenes map (case-insensitive key match), falling back to
 * the profile's first scene if the pillar itself is unrecognised — a fallback
 * for the fallback, so this never returns nothing.
 *
 * @param {import('./profiles.js').SiteProfile} profile
 * @param {string} pillar
 * @returns {string}
 */
function fallbackSceneFor(profile, pillar) {
  const key = String(pillar || '').toLowerCase();
  return profile.fallbackScenes[key] || Object.values(profile.fallbackScenes)[0];
}

/**
 * Asks Claude for a single concrete scene description for this article.
 *
 * Its remit is deliberately NARROW — one sentence naming a subject and setting.
 * Everything else (lighting, palette, composition, the negative constraints)
 * comes from the fixed template, so per-post variety never drifts the house
 * style. The artifact-avoidance rules are baked in here too, because the
 * cheapest place to prevent a mangled hand is to never ask for one.
 *
 * @param {object} topic { title, pillar, pitch }
 * @param {{variation?: boolean, profile?: import('./profiles.js').SiteProfile}} [options] Set variation when REGENERATING, so
 *   the brief deliberately moves to a different setting rather than re-rolling
 *   the same concept. A bad image is often a bad idea, not a bad render.
 *   profile defaults to Academy, matching every pre-existing caller.
 * @returns {Promise<string>} One-sentence scene description
 */
export async function describeScene(topic, { variation = false, profile = getProfile('academy') } = {}) {
  const fallback = fallbackSceneFor(profile, topic.pillar);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[imageGen] ANTHROPIC_API_KEY not set — using the fallback scene.');
    return fallback;
  }

  const wantsPeople = style(profile) === 'photoreal';
  const instruction = wantsPeople
    ? [
        'Describe ONE concrete, photographable scene that evokes the article without illustrating it literally.',
        'Real South African settings only (offices, training rooms, workshops, campuses, small businesses, homes) —',
        'make the LOCATION recognisably South African through concrete visual details (a Johannesburg/Sandton or Cape',
        'Town skyline glimpsed through a window, jacaranda trees, highveld light, red-brick or corrugated-iron',
        'commercial architecture), not a generic modern interior that could be anywhere in the world.',
        'People may appear, but keep them at mid-distance or seen from behind or in profile.',
        'NEVER describe: close-ups of hands, fingers on keyboards, readable screens, text, signage, or logos.',
      ].join(' ')
    : [
        'Describe ONE abstract conceptual object or geometric arrangement that symbolises the article.',
        'Objects and forms only — never people, faces, hands, text or logos.',
      ].join(' ');

  const prompt = `${profile.imageFraming}

Article title: "${topic.title}"
Pillar: ${topic.pillar}
${topic.pitch ? `Angle: ${topic.pitch}` : ''}

${instruction}
${variation ? '\nThis is a RETRY: the previous attempt was rejected. Deliberately choose a DIFFERENT setting, subject and camera angle from the most obvious interpretation of this title — not a variation on the same idea.\n' : ''}
Respond with ONE sentence of 30 words or fewer describing only the scene. No preamble, no quotation marks, no explanation.`;

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    logAnthropicUsage('imagePrompt', response);

    const text = (response.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim()
      // Strip surrounding quotes and any leading label the model may add.
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .replace(/^scene\s*:\s*/i, '');

    // A pathologically long or empty reply means the model ignored the brief;
    // the fallback is preferable to feeding junk into the image prompt.
    if (!text || text.length > 400) {
      console.warn('[imageGen] Scene description unusable — using the fallback scene.');
      return fallback;
    }
    return text;
  } catch (err) {
    console.warn(`[imageGen] Scene description failed (${err.message}) — using the fallback scene.`);
    return fallback;
  }
}

/**
 * Assembles the final image prompt: fixed art direction + this post's scene.
 *
 * @param {string} scene One-sentence scene description
 * @param {import('./profiles.js').SiteProfile} [profile] Defaults to Academy, matching every pre-existing caller
 * @returns {string} Complete prompt
 */
export function buildImagePrompt(scene, profile = getProfile('academy')) {
  const template = STYLE_TEMPLATES[style(profile)] || STYLE_TEMPLATES.photoreal;
  return template(scene);
}

// ---------------------------------------------------------------------------
// Providers. Each returns { buffer, contentType, model }.
// ---------------------------------------------------------------------------

/**
 * Cloudflare Workers AI. FLUX.2 models take multipart/form-data (the rest of the
 * catalogue takes JSON) and answer with base64 inside a JSON envelope.
 */
async function generateViaCloudflare(prompt, width, height) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new ImageGenerationError('CF_ACCOUNT_ID and CF_API_TOKEN are required for IMAGE_PROVIDER=cloudflare');
  }

  const model = process.env.CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-2-dev';
  const steps = Number(process.env.CF_IMAGE_STEPS || 20);

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(width));
  form.append('height', String(height));
  form.append('steps', String(steps));

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: 'POST',
      // Content-Type is intentionally omitted so fetch supplies its own
      // multipart boundary; setting it by hand yields an unparseable body.
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    }
  );

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 400);
    throw new ImageGenerationError(`Cloudflare responded ${resp.status}: ${detail}`);
  }

  const json = await resp.json();
  const b64 =
    (json.result && typeof json.result.image === 'string' && json.result.image) ||
    (typeof json.result === 'string' && json.result) ||
    null;
  if (!b64) {
    throw new ImageGenerationError('Cloudflare returned no image data');
  }

  const buffer = Buffer.from(b64, 'base64');
  return { buffer, contentType: detectContentType(buffer), model };
}

/**
 * Google Gemini image models (Nano Banana). Note the free tier is a hard zero
 * for image generation — a 429 here means billing is not enabled on the project,
 * not that a rate window needs waiting out.
 */
async function generateViaGemini(prompt, width, height) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ImageGenerationError('GEMINI_API_KEY is required for IMAGE_PROVIDER=gemini');
  }

  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const aspectRatio = closestAspectRatio(width, height);

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio },
        },
      }),
    }
  );

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 400);
    const hint =
      resp.status === 429 && /limit: 0/.test(detail)
        ? ' (image generation has no free tier — enable billing on the Google Cloud project)'
        : '';
    throw new ImageGenerationError(`Gemini responded ${resp.status}${hint}: ${detail}`);
  }

  const json = await resp.json();
  const parts =
    (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
  const inline = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!inline) {
    throw new ImageGenerationError('Gemini returned no image data');
  }

  const buffer = Buffer.from(inline.inlineData.data, 'base64');
  return { buffer, contentType: inline.inlineData.mimeType || detectContentType(buffer), model };
}

/**
 * fal.ai FLUX.2 [pro] via the synchronous REST endpoint. Returns a CDN URL that
 * must be downloaded — fal media expires after roughly 7 days.
 */
async function generateViaFal(prompt, width, height) {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new ImageGenerationError('FAL_KEY is required for IMAGE_PROVIDER=fal');
  }

  const model = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux-2-pro';

  const resp = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      image_size: width >= height ? 'landscape_16_9' : 'portrait_16_9',
      output_format: 'jpeg',
      num_images: 1,
    }),
  });

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 400);
    throw new ImageGenerationError(`fal responded ${resp.status}: ${detail}`);
  }

  const json = await resp.json();
  const url = json.images && json.images[0] && json.images[0].url;
  if (!url) {
    throw new ImageGenerationError('fal returned no image URL');
  }

  const imgResp = await fetch(url);
  if (!imgResp.ok) {
    throw new ImageGenerationError(`Could not download the fal image (HTTP ${imgResp.status})`);
  }
  const buffer = Buffer.from(await imgResp.arrayBuffer());
  return { buffer, contentType: detectContentType(buffer), model };
}

/**
 * Maps our arbitrary width/height (the shared `imageWidth()`/`imageHeight()`
 * config, e.g. 1024x576 for 16:9) onto the nearest size OpenAI's Images API
 * actually accepts — it takes a fixed enum, not arbitrary dimensions.
 * Restricted to the three "standard" sizes (not the 2K/4K options) to keep
 * cost predictable by default; override with OPENAI_IMAGE_SIZE if a specific
 * size is wanted.
 *
 * @param {number} width
 * @param {number} height
 * @returns {string} One of '1024x1024' | '1536x1024' | '1024x1536'
 */
function closestOpenAiSize(width, height) {
  const target = width / height;
  const options = { '1024x1024': 1, '1536x1024': 1536 / 1024, '1024x1536': 1024 / 1536 };
  let best = '1024x1024';
  let bestDelta = Infinity;
  for (const [name, value] of Object.entries(options)) {
    const delta = Math.abs(value - target);
    if (delta < bestDelta) { bestDelta = delta; best = name; }
  }
  return best;
}

/**
 * OpenAI GPT Image (gpt-image-2 by default). Always returns base64 — there is
 * no CDN-URL response mode like the old DALL-E API had, which actually makes
 * this the simplest provider: no separate download step.
 *
 * Requires the OpenAI ORGANIZATION (not just the API key) to have completed
 * "API Organization Verification" in the dashboard; unverified orgs get a 403
 * on every request regardless of how valid the key is.
 */
async function generateViaOpenAI(prompt, width, height) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ImageGenerationError('OPENAI_API_KEY is required for IMAGE_PROVIDER=openai');
  }

  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const size = process.env.OPENAI_IMAGE_SIZE || closestOpenAiSize(width, height);
  // 'medium' beat 'high' in side-by-side testing: ~37s vs ~100s (high risks
  // exceeding Vercel's 60s maxDuration) and produced a warmer, more editorial
  // result rather than a flatter, more "corporate stock photo" look.
  const quality = process.env.OPENAI_IMAGE_QUALITY || 'medium';

  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, quality }),
  });

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 400);
    const hint =
      resp.status === 403
        ? ' (GPT Image models require completing API Organization Verification in the OpenAI dashboard first)'
        : '';
    throw new ImageGenerationError(`OpenAI responded ${resp.status}${hint}: ${detail}`);
  }

  const json = await resp.json();
  const b64 = json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) {
    throw new ImageGenerationError('OpenAI returned no image data');
  }

  const buffer = Buffer.from(b64, 'base64');
  return { buffer, contentType: detectContentType(buffer), model };
}

/**
 * Offline placeholder. Builds a real, valid PNG locally (zlib is built into
 * node), so every downstream path — upload, public URL, Discord embed, dashboard
 * preview — can be exercised with no network and no cost.
 */
async function generateViaStub(prompt, width, height) {
  const buffer = solidPng(width, height, [58, 2, 48]); // #3a0230
  return { buffer, contentType: 'image/png', model: 'stub' };
}

const PROVIDERS = {
  cloudflare: generateViaCloudflare,
  gemini: generateViaGemini,
  fal: generateViaFal,
  openai: generateViaOpenAI,
  stub: generateViaStub,
};

// Credentials each provider needs, validated UP FRONT so a misconfigured
// provider fails before describeScene() spends a Claude call on a scene brief
// that can never be rendered. Previously the check lived inside each provider,
// which meant every attempt with a missing key still cost a billed request.
const PROVIDER_REQUIRED_ENV = {
  cloudflare: ['CF_ACCOUNT_ID', 'CF_API_TOKEN'],
  gemini: ['GEMINI_API_KEY'],
  fal: ['FAL_KEY'],
  openai: ['OPENAI_API_KEY'],
  stub: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Identifies an image's type from its magic bytes. The content type must be
 * right at upload time or Supabase serves the file with a type browsers refuse
 * to render inline.
 *
 * @param {Buffer} buf
 * @returns {string} MIME type
 */
export function detectContentType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/**
 * Reads pixel dimensions straight from a PNG or JPEG header. Used for logging
 * and verification; never load-bearing.
 *
 * @param {Buffer} buf
 * @returns {{width: number|null, height: number|null}}
 */
export function readImageDimensions(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { width: null, height: null };
}

/**
 * Maps pixel dimensions onto the nearest aspect-ratio string Gemini accepts.
 *
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
function closestAspectRatio(width, height) {
  const target = width / height;
  const options = { '1:1': 1, '4:3': 4 / 3, '3:2': 1.5, '16:9': 16 / 9, '21:9': 21 / 9, '9:16': 9 / 16, '3:4': 0.75 };
  let best = '16:9';
  let bestDelta = Infinity;
  for (const [name, value] of Object.entries(options)) {
    const delta = Math.abs(value - target);
    if (delta < bestDelta) { bestDelta = delta; best = name; }
  }
  return best;
}

/** CRC-32, needed to emit valid PNG chunks for the stub provider. */
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Builds a valid single-colour PNG with no external dependencies. */
function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  // 10-12: compression, filter, interlace — all zero

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Copies the generated bytes into Supabase Storage and returns the permanent
 * public URL. This is what makes the result durable: provider CDN URLs expire,
 * this one does not.
 *
 * @param {Buffer} buffer Image bytes
 * @param {string} contentType MIME type
 * @param {string} titleForSlug Used to build a readable object name
 * @returns {Promise<string>} Public URL
 */
async function uploadToStorage(buffer, contentType, titleForSlug) {
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const base = (generateSlug(titleForSlug) || 'post').slice(0, 60);
  const objectPath = `${STORAGE_PREFIX}/${base}-${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, buffer, { contentType, upsert: false });

  if (error) {
    throw new ImageGenerationError(`Supabase upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath);
  if (!data || !data.publicUrl) {
    throw new ImageGenerationError('Could not resolve the uploaded image public URL');
  }
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a featured image for a topic and returns its permanent public URL.
 *
 * THROWS on failure — use this where the caller wants to surface the error (the
 * explicit "generate an image" endpoint and button). On the draft-save path use
 * generateFeaturedImageSafe() instead.
 *
 * @param {object} topic { title, pillar, pitch }
 * @param {{variation?: boolean, profile?: import('./profiles.js').SiteProfile}} [options] Pass variation on a REGENERATE so the
 *   scene brief moves to a different concept rather than re-rolling the same one.
 *   profile defaults to Academy, matching every pre-existing caller.
 * @returns {Promise<{url: string, provider: string, model: string, bytes: number,
 *   width: number|null, height: number|null, scene: string, elapsedMs: number}>}
 */
export async function generateFeaturedImage(topic, { variation = false, profile = getProfile('academy') } = {}) {
  if (!topic || !topic.title) {
    throw new ImageGenerationError('A topic with a title is required');
  }

  const selected = provider();
  const generate = PROVIDERS[selected];
  if (!generate) {
    throw new ImageGenerationError(
      `Unknown IMAGE_PROVIDER "${selected}" (expected one of: ${Object.keys(PROVIDERS).join(', ')})`
    );
  }

  // Fail before spending anything: describeScene() below is a billed Claude
  // call, and there is no point paying for a scene brief that cannot be rendered.
  const missing = (PROVIDER_REQUIRED_ENV[selected] || []).filter((name) => !process.env[name]);
  if (missing.length) {
    throw new ImageGenerationError(
      `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} required for IMAGE_PROVIDER=${selected}`
    );
  }

  const started = Date.now();
  const scene = await describeScene(topic, { variation, profile });
  const prompt = buildImagePrompt(scene, profile);

  const width = imageWidth();
  const height = imageHeight();
  console.log(`[imageGen] Line=${profile.key} Provider=${selected} style=${style(profile)} ${width}x${height}`);
  console.log(`[imageGen] Scene: ${scene}`);

  const { buffer, contentType, model } = await generate(prompt, width, height);
  if (!buffer || !buffer.length) {
    throw new ImageGenerationError('Provider returned an empty image');
  }

  const url = await uploadToStorage(buffer, contentType, topic.title);
  const dims = readImageDimensions(buffer);
  const elapsedMs = Date.now() - started;

  console.log(
    `[imageGen] OK — ${dims.width || '?'}x${dims.height || '?'} ${(buffer.length / 1024).toFixed(0)}KB ` +
    `in ${(elapsedMs / 1000).toFixed(1)}s via ${model}`
  );

  return { url, provider: selected, model, bytes: buffer.length, width: dims.width, height: dims.height, scene, elapsedMs };
}

/**
 * Regenerates the featured image for an existing DRAFT and persists the new URL.
 *
 * Shared by the Discord "Regenerate image" button and the dashboard's
 * POST /api/image, so the draft-only rule and the variation behaviour cannot
 * drift apart between the two entry points.
 *
 * PUBLISHED POSTS ARE REFUSED. Regenerating a live post would swap the image on
 * the website instantly, with no preview and no undo — the exact review step
 * this whole feature exists to provide.
 *
 * The previous image is deliberately left in storage rather than deleted: it
 * costs fractions of a cent to keep, and deleting it would break the live page
 * of anything that had already referenced it.
 *
 * @param {string} draftId The post's UUID
 * @param {import('./profiles.js').SiteProfile} [profile] Which table to look the draft up in — defaults to Academy
 * @returns {Promise<{url: string, title: string, slug: string, excerpt: string,
 *   scene: string, previousImage: string|null}>}
 * @throws {ImageGenerationError} When the post is missing, is not a draft, or
 *   generation fails
 */
export async function regenerateImageForDraft(draftId, profile = getProfile('academy')) {
  const id = String(draftId || '').trim();
  if (!id) throw new ImageGenerationError('A draft id is required');

  const { data: post, error } = await supabase
    .from(profile.table)
    .select('id, slug, title, excerpt, pillar, status, image')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new ImageGenerationError(`Lookup failed: ${error.message}`);
  if (!post) throw new ImageGenerationError('That draft no longer exists — it may have been deleted.');
  if (post.status !== 'draft') {
    throw new ImageGenerationError(
      `Only drafts can have their image regenerated (this post is ${post.status}). ` +
      'Change the image from the dashboard instead.'
    );
  }

  // variation: true — a rejected image is usually a rejected IDEA, so the brief
  // moves to a different setting rather than re-rolling the same concept.
  const result = await generateFeaturedImage(
    { title: post.title, pillar: post.pillar, pitch: post.excerpt },
    { variation: true, profile }
  );

  const { error: updErr } = await supabase
    .from(profile.table)
    .update({ image: result.url })
    .eq('id', post.id);

  if (updErr) {
    throw new ImageGenerationError(`Could not save the new image: ${updErr.message}`);
  }

  console.log(`[imageGen] Regenerated image for draft ${post.id} (${post.slug})`);

  return {
    url: result.url,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    scene: result.scene,
    previousImage: post.image || null,
  };
}

/**
 * Non-throwing wrapper for the draft-save path.
 *
 * A post that was written successfully must never be lost because its
 * decorative hero image could not be produced. Any failure is logged and
 * reported, and the caller simply proceeds with no image — exactly the
 * behaviour that existed before images were automated at all.
 *
 * @param {object} topic { title, pillar, pitch }
 * @param {import('./profiles.js').SiteProfile} [profile] Defaults to Academy, matching every pre-existing caller
 * @returns {Promise<object|null>} The result, or null on any failure
 */
export async function generateFeaturedImageSafe(topic, profile = getProfile('academy')) {
  try {
    return await generateFeaturedImage(topic, { profile });
  } catch (err) {
    console.warn(`[imageGen] Featured image skipped: ${err.message}`);
    return null;
  }
}

// standalone run block
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('--- STANDALONE TESTING: src/imageGen.js ---');

  const title = process.argv[2] || 'Cybersecurity Courses in South Africa: Skills for AI-Powered Threats';
  const pillar = process.argv[3] || 'tech';

  generateFeaturedImage({ title, pillar, pitch: '' })
    .then((result) => {
      console.log('\n--- RESULT ---');
      console.log(JSON.stringify(result, null, 2));
      console.log('\nOpen the url above in a browser to review the image.');
    })
    .catch((err) => {
      console.error('Failed standalone image run:', err.message);
      process.exit(1);
    });
}
