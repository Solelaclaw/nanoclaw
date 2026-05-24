/**
 * Per-turn token + cost capture for the host's admin dashboard.
 *
 * Every time the Claude Agent SDK emits a `result` message we append one
 * line to `/workspace/usage.jsonl` — that's the per-session mount point
 * which on the host maps to
 * `data/v2-sessions/<agentGroupId>/<sessionId>/usage.jsonl`. The host's
 * web channel walks every agent's session dirs and sums these lines.
 *
 * Why JSONL, not the existing SQLite outbound.db:
 *   - Append-only, no schema migration, no lock contention with the
 *     existing outbound.db writes.
 *   - Trivial to read from the host: stream-parse line-by-line, sum.
 *   - Per-line records survive process crashes cleanly (last incomplete
 *     line is just discarded by the reader).
 *
 * The cost figure comes straight from the SDK (`total_cost_usd` and
 * `modelUsage[x].costUSD`) — Anthropic already does the math including
 * any tool surcharges, cache pricing tiers, model-specific rates. We
 * deliberately do NOT maintain our own pricing table.
 *
 * IMPORTANT caveat for the consumer of these numbers: when an agent is
 * authenticated via Claude.ai OAuth (Pro/Max subscription) instead of
 * an Anthropic API key, the SDK still emits `costUSD` but the user
 * doesn't actually pay it — the subscription covers usage. The auth
 * mode lives on the OneCLI side, not here, so this file is auth-mode
 * agnostic. The admin UI should label this column "estimated API
 * cost" rather than "billed cost".
 */
import fs from 'fs';

const USAGE_LOG_PATH = '/workspace/usage.jsonl';

/** One row in usage.jsonl — kept small so it's cheap to read in bulk. */
export interface UsageRecord {
  /** ISO 8601 timestamp of when the turn completed. */
  ts: string;
  /** SDK result subtype — 'success' or one of the error variants. */
  subtype: string;
  /** Total dollar cost for the turn, summed across all models used. */
  costUsd: number;
  /** Total input tokens (non-cached). */
  inputTokens: number;
  /** Total output tokens. */
  outputTokens: number;
  /** Tokens served from prompt cache (much cheaper). */
  cacheReadTokens: number;
  /** Tokens written into prompt cache (slightly more expensive). */
  cacheWriteTokens: number;
  /** Number of web-search requests made during the turn (each is billed
   * separately by Anthropic). */
  webSearchRequests: number;
  /** Wall-clock duration of the turn. */
  durationMs: number;
  /** Time spent waiting on the Anthropic API specifically. */
  apiDurationMs: number;
  /** Number of agent turns this took (multi-step tool use → > 1). */
  numTurns: number;
  /** Per-model breakdown: model id → { costUSD, input, output, cacheR,
   * cacheW }. Useful when an agent uses both Sonnet and Opus in one
   * conversation (e.g. Opus for planning, Sonnet for execution). */
  byModel: Record<string, ModelBreakdown>;
}

export interface ModelBreakdown {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests: number;
}

/** Shape of the SDK's result message we care about. Kept loose so a
 * minor-version SDK bump that adds fields doesn't break us. */
interface SdkResultLike {
  type: 'result';
  subtype?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      webSearchRequests?: number;
      costUSD?: number;
    }
  >;
}

/**
 * Pull usage stats out of an SDK `result` message and append one
 * JSONL line to /workspace/usage.jsonl. Fire-and-forget — any error
 * (disk full, mount missing) is logged to stderr but never thrown,
 * so usage logging can't break the agent's reply.
 */
export function recordUsageFromSdkResult(message: unknown): void {
  if (!isSdkResult(message)) return;

  const byModel: Record<string, ModelBreakdown> = {};
  let webSearchTotal = 0;
  if (message.modelUsage) {
    for (const [model, mu] of Object.entries(message.modelUsage)) {
      const ws = mu.webSearchRequests ?? 0;
      webSearchTotal += ws;
      byModel[model] = {
        costUsd: mu.costUSD ?? 0,
        inputTokens: mu.inputTokens ?? 0,
        outputTokens: mu.outputTokens ?? 0,
        cacheReadTokens: mu.cacheReadInputTokens ?? 0,
        cacheWriteTokens: mu.cacheCreationInputTokens ?? 0,
        webSearchRequests: ws,
      };
    }
  }

  const record: UsageRecord = {
    ts: new Date().toISOString(),
    subtype: message.subtype ?? 'unknown',
    costUsd: message.total_cost_usd ?? 0,
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
    cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
    webSearchRequests: webSearchTotal,
    durationMs: message.duration_ms ?? 0,
    apiDurationMs: message.duration_api_ms ?? 0,
    numTurns: message.num_turns ?? 1,
    byModel,
  };

  try {
    fs.appendFileSync(USAGE_LOG_PATH, JSON.stringify(record) + '\n');
  } catch (err) {
    // Mount missing, disk full, permission issue — log and continue.
    // We never want this to bubble up and break the agent loop.
    console.error(`[usage-log] append failed: ${(err as Error).message}`);
  }
}

function isSdkResult(value: unknown): value is SdkResultLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'result'
  );
}
