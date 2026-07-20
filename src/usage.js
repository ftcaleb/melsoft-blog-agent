// Shared Anthropic usage/cost logging.
// Called after every anthropic.messages.create() so we have real per-run
// token + web_search visibility instead of estimates.

/**
 * Logs token usage and web-search count for a single Anthropic response.
 *
 * @param {string} label Short call-site label (e.g. 'research', 'writer')
 * @param {object} response The response object returned by anthropic.messages.create()
 */
export function logAnthropicUsage(label, response) {
  const u = (response && response.usage) || {};
  const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;

  const inputTokens = u.input_tokens || 0;
  const outputTokens = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;

  console.log(
    `[usage:${label}] input=${inputTokens} output=${outputTokens} ` +
    `cache_write=${cacheWrite} cache_read=${cacheRead} web_searches=${searches}`
  );
}
