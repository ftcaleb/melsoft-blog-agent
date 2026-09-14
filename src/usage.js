// Shared model usage/cost logging.
// Called after every generateText() so we have real per-run token,
// reasoning and web-search visibility instead of estimates.

/**
 * Logs token usage for a single normalised model response.
 *
 * Accepts the canonical shape from textProvider.js (camelCase usage fields)
 * and also a raw Anthropic SDK response, so a call site that still talks to
 * the SDK directly keeps logging correctly.
 *
 * Reasoning tokens are surfaced separately because OpenAI bills them as
 * output: a response can look small and still cost like a large one.
 *
 * @param {string} label Short call-site label (e.g. 'research', 'writer')
 * @param {object} response A normalised response, or a raw Anthropic response
 */
export function logModelUsage(label, response) {
  const u = (response && response.usage) || {};

  // Canonical shape uses camelCase; a raw Anthropic response uses snake_case.
  const isCanonical = typeof u.inputTokens === 'number';

  const inputTokens = isCanonical ? u.inputTokens : (u.input_tokens || 0);
  const outputTokens = isCanonical ? u.outputTokens : (u.output_tokens || 0);
  const cacheWrite = isCanonical ? u.cacheWrite : (u.cache_creation_input_tokens || 0);
  const cacheRead = isCanonical ? u.cacheRead : (u.cache_read_input_tokens || 0);
  const reasoning = isCanonical ? u.reasoningTokens : 0;
  const searches = isCanonical
    ? u.webSearches
    : ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0);

  const meta = (response && response._meta) || {};
  const origin = meta.provider ? `${meta.provider}/${meta.model} ` : '';

  console.log(
    `[usage:${label}] ${origin}input=${inputTokens} output=${outputTokens} ` +
    `reasoning=${reasoning} cache_write=${cacheWrite} cache_read=${cacheRead} web_searches=${searches}`
  );
}
