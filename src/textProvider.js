// Text-generation provider switch (Anthropic | OpenAI).
//
// Mirrors the provider pattern already proven in imageGen.js: one env var
// picks the vendor, everything else — prompts, parsing, validation — is
// shared. Set TEXT_PROVIDER to choose:
//
//   anthropic  Claude (claude-haiku-4-5 by default). The original path.
//   openai     OpenAI Responses API (gpt-5.6-luna by default).
//
// WHY AN ADAPTER RATHER THAN A REWRITE: writer.js and research.js contain the
// hardened parser built after the 2026-07-27 incident, where model scaffolding
// reached the live blog. That parser is the most safety-critical code here, and
// it consumes Anthropic's `content` block array. So every provider normalises
// its response INTO that shape:
//
//   { content: [{ type: 'text', text }], stop_reason, usage, _meta }
//
// The callers stay provider-agnostic, the incident defences keep working
// untouched, and switching vendors is one env var rather than a re-test of
// everything downstream.
//
// SHAPE DIFFERENCE WORTH KNOWING (measured against both live APIs):
//   Anthropic emits ONE text block PER SAMPLING TURN when server-side tools
//   run — the concatenation trap that caused the incident.
//   OpenAI returns exactly ONE `message` item; searches are separate
//   `web_search_call` items, never text. The multi-block hazard therefore
//   cannot arise on the OpenAI path, but the parser still handles it so the
//   Anthropic path stays safe.
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

// Read at CALL time, not module load, so an env change takes effect without
// redeploying this module's import graph (same rationale as imageGen.js).
//
// Defaults to 'openai' — the intended production vendor — rather than to the
// legacy path. A default that disagrees with production is how IMAGE_PROVIDER
// silently ran the wrong image provider for days: the env var was set in one
// environment but not another, and nothing surfaced the mismatch. Set
// TEXT_PROVIDER=anthropic to roll back.
const providerName = () => (process.env.TEXT_PROVIDER || 'openai').toLowerCase();

const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
// gpt-5.6-luna measured cheapest by an order of magnitude while still running
// web search and honouring the brand rules; see docs for the comparison.
const OPENAI_DEFAULT_MODEL = 'gpt-5.6-luna';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** Thrown for a provider/config problem the caller cannot retry its way out of. */
export class TextProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TextProviderError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries transient server-side failures (5xx, or connection errors with no
 * status) with short exponential backoff. Never retries a 4xx — that means the
 * request itself is wrong, and retrying only wastes time before failing the
 * same way.
 */
async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, label = 'text' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = !err.status || err.status >= 500;
      if (!retryable || i === attempts) throw err;
      const delay = baseDelayMs * 2 ** (i - 1);
      console.warn(`[${label}] API error (attempt ${i}/${attempts}, status ${err.status || 'n/a'}): ${err.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function callAnthropic({ prompt, maxTokens, schema, webSearchMaxUses, model, label, allowSchema }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new TextProviderError('ANTHROPIC_API_KEY is not defined in process.env');

  const anthropic = new Anthropic({ apiKey });
  const baseParams = {
    model: model || process.env.TEXT_MODEL || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (webSearchMaxUses) {
    baseParams.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: webSearchMaxUses }];
  }

  const params = schema && allowSchema
    ? { ...baseParams, output_config: { format: { type: 'json_schema', schema } } }
    : baseParams;

  const response = await withRetry(() => anthropic.messages.create(params), { label });

  // Already the canonical shape — pass through, normalising only usage.
  return {
    content: response.content,
    stop_reason: response.stop_reason,
    usage: normaliseAnthropicUsage(response.usage),
    _meta: { provider: 'anthropic', model: params.model, schemaUsed: params !== baseParams },
  };
}

function normaliseAnthropicUsage(u = {}) {
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    reasoningTokens: 0,
    webSearches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
  };
}

// ---------------------------------------------------------------------------
// OpenAI (Responses API)
// ---------------------------------------------------------------------------

async function callOpenAI({ prompt, maxTokens, schema, webSearchMaxUses, model, label, allowSchema }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new TextProviderError('OPENAI_API_KEY is not defined in process.env');

  const resolvedModel = model || process.env.TEXT_MODEL || OPENAI_DEFAULT_MODEL;

  const body = {
    model: resolvedModel,
    input: prompt,
    max_output_tokens: maxTokens,
  };
  if (webSearchMaxUses) {
    body.tools = [{ type: 'web_search' }];
    // The Responses API caps total tool calls rather than per-tool uses. Bound
    // it so a model that keeps searching cannot run the request past the
    // function timeout — the failure mode that 504'd the cron in September.
    body.max_tool_calls = webSearchMaxUses;
  }
  if (schema && allowSchema) {
    // strict mode requires additionalProperties:false and every property listed
    // in `required` — both already true of the callers' schemas.
    body.text = { format: { type: 'json_schema', name: 'structured_output', schema, strict: true } };
  }

  const response = await withRetry(async () => {
    const resp = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 400);
      throw new TextProviderError(`OpenAI responded ${resp.status}: ${detail}`, resp.status);
    }
    return resp.json();
  }, { label });

  return normaliseOpenAIResponse(response, { model: resolvedModel, schemaUsed: !!(schema && allowSchema) });
}

/**
 * Converts an OpenAI Responses payload into the canonical Anthropic-shaped
 * response the parsers expect.
 *
 * Exported for tests: this mapping is the highest-risk part of the port, so it
 * is exercised against recorded real payloads rather than trusted by eye.
 *
 * @param {object} response Raw Responses API JSON
 * @param {{model?: string, schemaUsed?: boolean}} [meta]
 * @returns {{content: object[], stop_reason: string|null, usage: object, _meta: object}}
 */
export function normaliseOpenAIResponse(response, meta = {}) {
  const output = Array.isArray(response && response.output) ? response.output : [];

  // Exactly one `message` item carries the answer; `web_search_call` and
  // `reasoning` items are siblings, never text. Scan newest-first anyway so a
  // future multi-message shape degrades to "latest wins" rather than breaking.
  const textBlocks = [];
  for (let i = output.length - 1; i >= 0; i--) {
    const item = output[i];
    if (!item || item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part && typeof part.text === 'string' && part.text) {
        textBlocks.push({ type: 'text', text: part.text });
      }
    }
  }

  // `status: 'incomplete'` with reason 'max_output_tokens' is OpenAI's
  // equivalent of Anthropic's stop_reason 'max_tokens'. Map it so the callers'
  // existing truncation guard fires identically on both providers.
  const incompleteReason = response && response.incomplete_details && response.incomplete_details.reason;
  const stopReason = incompleteReason === 'max_output_tokens' ? 'max_tokens' : (response && response.status) || null;

  const u = (response && response.usage) || {};
  return {
    content: textBlocks,
    stop_reason: stopReason,
    usage: {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheWrite: (u.input_tokens_details && u.input_tokens_details.cache_write_tokens) || 0,
      cacheRead: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0,
      reasoningTokens: (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0,
      // No usage counter for hosted search; count the call items instead.
      webSearches: output.filter((o) => o && o.type === 'web_search_call').length,
    },
    _meta: { provider: 'openai', model: meta.model, schemaUsed: !!meta.schemaUsed },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PROVIDERS = { anthropic: callAnthropic, openai: callOpenAI };

// Cleared per provider if the API ever rejects structured output, so the run
// degrades to the parser rather than failing. Never flipped back within a
// process — one probe per boot is enough.
const structuredOutputSupported = { anthropic: true, openai: true };

/**
 * Generates text with the configured provider and returns a canonical,
 * Anthropic-shaped response.
 *
 * Handles, uniformly for both providers: transient-5xx retry with backoff,
 * graceful degradation when structured output is rejected, and a single
 * unconstrained retry when a structured request keeps failing server-side
 * (the schema + web-search combination has caused vendor-side 500s before).
 *
 * @param {object} options
 * @param {string} options.prompt The full user prompt
 * @param {number} options.maxTokens Output cap
 * @param {object} [options.schema] JSON schema to constrain decoding
 * @param {number} [options.webSearchMaxUses] Enable hosted web search, bounded
 * @param {string} [options.model] Override the configured model
 * @param {string} [options.label] Log label, e.g. 'writer'
 * @returns {Promise<{content: object[], stop_reason: string|null, usage: object, _meta: object}>}
 */
export async function generateText({ prompt, maxTokens, schema, webSearchMaxUses, model, label = 'text' }) {
  const name = providerName();
  const call = PROVIDERS[name];
  if (!call) {
    throw new TextProviderError(
      `Unknown TEXT_PROVIDER "${name}" (expected one of: ${Object.keys(PROVIDERS).join(', ')})`
    );
  }

  const args = { prompt, maxTokens, schema, webSearchMaxUses, model, label };

  if (!schema || !structuredOutputSupported[name]) {
    return call({ ...args, allowSchema: false });
  }

  try {
    return await call({ ...args, allowSchema: true });
  } catch (err) {
    const rejectedSchema =
      err && err.status === 400 &&
      /output_config|json_schema|output_format|response_format|schema/i.test(String(err.message || ''));
    // Retries are already exhausted here, so a 5xx means the structured
    // (schema + web_search) request kept failing server-side.
    const persistentServerError = err && (!err.status || err.status >= 500);

    if (!rejectedSchema && !persistentServerError) throw err;

    if (rejectedSchema) {
      console.warn(`[${label}] ${name} rejected structured output — falling back to unconstrained output for this process.`);
      structuredOutputSupported[name] = false;
    } else {
      console.warn(`[${label}] Structured request kept failing server-side — retrying once without the schema in case that combination is the trigger.`);
    }
    return call({ ...args, allowSchema: false });
  }
}

/** The active provider name, for logging and provider-specific behaviour. */
export function activeTextProvider() {
  return providerName();
}
