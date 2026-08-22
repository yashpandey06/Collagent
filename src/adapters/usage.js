/**
 * Normalized usage record attached to `result` events (and rolled up into
 * turn_completed). Adapters fill what their runtime exposes and leave the
 * rest null — usage data is never discarded and costs are never invented.
 */
export function usageRecord({
  provider = null,
  runtime = null,
  model = null,
  inputTokens = null,
  outputTokens = null,
  cacheReadTokens = null,
  cacheWriteTokens = null,
  providerCost = null,
  currency = null,
} = {}) {
  return {
    provider,
    runtime,
    model,
    inputTokens: numOrNull(inputTokens),
    outputTokens: numOrNull(outputTokens),
    cacheReadTokens: numOrNull(cacheReadTokens),
    cacheWriteTokens: numOrNull(cacheWriteTokens),
    providerCost: numOrNull(providerCost),
    currency: currency ?? (providerCost != null ? 'USD' : null),
  };
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
