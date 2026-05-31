/**
 * OpenTelemetry metrics for LLM token usage.
 *
 * Why: per-user / per-channel / per-model token + cost breakdowns
 * that the existing /workspace/usage.jsonl rollup can't give us
 * cheaply. The jsonl stays — it's the cheap aggregate the admin
 * dashboard reads — and OTel is the deep-query layer on top.
 *
 * Emits OpenTelemetry GenAI semantic-convention metrics:
 *   - `gen_ai.client.token.usage`  (counter, tokens)  with attrs
 *       gen_ai.system / gen_ai.request.model / gen_ai.token.type
 *   - `gen_ai.client.cost_usd`     (counter, USD)     custom, not
 *       yet in the GenAI semconv but every backend renders it fine
 *
 * Resource attributes (set once per container) tag every datapoint:
 *   service.name              = "nanoclaw-agent-runner"
 *   nanoclaw.agent_group_id   = NANOCLAW_AGENT_GROUP_ID
 *   nanoclaw.session_id       = NANOCLAW_SESSION_ID
 *   channel.type              = NANOCLAW_CHANNEL_TYPE
 *
 * These come from env vars set by the host (container-runner.ts) at
 * spawn time. They're cheap dimensions for slicing — "tokens by
 * channel", "cost by agent_group", etc.
 *
 * Transport: standard OTLP/HTTP. Reads `OTEL_EXPORTER_OTLP_ENDPOINT`
 * (and optional `OTEL_EXPORTER_OTLP_HEADERS` for auth tokens). When
 * the endpoint env var is unset, the whole module no-ops — no
 * exporter, no MeterProvider, no network calls. Safe to deploy
 * before picking a backend.
 *
 * Backends: any OTLP/HTTP receiver works. We don't pin to one.
 * Recommended for low-friction setup:
 *   - Axiom              (generous free tier, OTLP-native)
 *   - Honeycomb          (gold standard for tracing, less so metrics)
 *   - Grafana Cloud      (free tier, alloy collector)
 *   - SigNoz Cloud       (open-source first, free tier)
 */
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

import type { ModelBreakdown } from '../usage-log.js';

let initialized = false;
let inputTokenCounter: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;
let costCounter: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;

/**
 * Initialize the OTel pipeline. Called from agent-runner's entry
 * point. Idempotent + safe to skip (no-op when no OTEL endpoint
 * configured). Never throws — if init fails, metrics just don't
 * ship and the agent runs normally.
 */
export function initOtel(): void {
  if (initialized) return;
  initialized = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    // No backend configured — module stays inert. Counters created
    // below would still work locally but with no exporter they
    // accumulate forever; cheaper to just not create them.
    return;
  }

  try {
    const exporter = new OTLPMetricExporter({
      // Per OTLP spec the metrics endpoint is `<base>/v1/metrics`.
      // Most backends accept the base URL too; we append for safety.
      url: endpoint.endsWith('/v1/metrics') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/metrics`,
      headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    });

    const reader = new PeriodicExportingMetricReader({
      exporter,
      // 30s is the OTel default; the per-turn cadence is much slower
      // than that, so we don't lose precision by batching.
      exportIntervalMillis: 30_000,
    });

    const provider = new MeterProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'nanoclaw-agent-runner',
        [SemanticResourceAttributes.SERVICE_VERSION]:
          process.env.NANOCLAW_AGENT_RUNNER_VERSION ?? 'unknown',
        // Container-shape dimensions — set by the host at spawn time.
        // Keep as plain string attributes; semconv doesn't define
        // nanoclaw-specific keys.
        'nanoclaw.agent_group_id': process.env.NANOCLAW_AGENT_GROUP_ID ?? 'unknown',
        'nanoclaw.session_id': process.env.NANOCLAW_SESSION_ID ?? 'unknown',
        'channel.type': process.env.NANOCLAW_CHANNEL_TYPE ?? 'unknown',
      }),
      readers: [reader],
    });

    metrics.setGlobalMeterProvider(provider);

    const meter = metrics.getMeter('nanoclaw-agent-runner');
    inputTokenCounter = meter.createCounter('gen_ai.client.token.usage', {
      description:
        'Number of input/output/cache tokens used by an LLM call. ' +
        'Attribute gen_ai.token.type distinguishes input/output/cache_read/cache_write.',
      unit: 'tokens',
    });
    costCounter = meter.createCounter('gen_ai.client.cost_usd', {
      description:
        'Estimated USD cost of an LLM call. Sourced from the Anthropic ' +
        'SDK so it correctly reflects cache pricing tiers and tool surcharges. ' +
        'Pro/Max subscription users will see this number even though they ' +
        'aren\'t billed it — auth mode is upstream of this metric.',
      unit: 'USD',
    });
  } catch (err) {
    console.error('[otel] init failed; metrics will not ship', err);
    initialized = true; // don't retry on every call
  }
}

/**
 * Record per-model token + cost numbers from one Claude SDK result.
 * Called from usage-log.ts right after the jsonl append.
 *
 * Emits one data-point per (model × token-type) combination plus
 * one for cost. Resource attrs (channel.type etc.) come from the
 * Resource defined at init time — no need to pass them every call.
 *
 * No-op when init hasn't created the counters (no endpoint set).
 */
export function recordGenAiUsageMetrics(input: {
  byModel: Record<string, ModelBreakdown>;
  subtype: string;
}): void {
  if (!inputTokenCounter || !costCounter) return;

  for (const [model, m] of Object.entries(input.byModel)) {
    const commonAttrs = {
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': model,
      'gen_ai.response.status': input.subtype,
    };

    if (m.inputTokens > 0) {
      inputTokenCounter.add(m.inputTokens, {
        ...commonAttrs,
        'gen_ai.token.type': 'input',
      });
    }
    if (m.outputTokens > 0) {
      inputTokenCounter.add(m.outputTokens, {
        ...commonAttrs,
        'gen_ai.token.type': 'output',
      });
    }
    if (m.cacheReadTokens > 0) {
      inputTokenCounter.add(m.cacheReadTokens, {
        ...commonAttrs,
        'gen_ai.token.type': 'cache_read',
      });
    }
    if (m.cacheWriteTokens > 0) {
      inputTokenCounter.add(m.cacheWriteTokens, {
        ...commonAttrs,
        'gen_ai.token.type': 'cache_write',
      });
    }
    if (m.costUsd > 0) {
      costCounter.add(m.costUsd, commonAttrs);
    }
  }
}

/**
 * Parse `OTEL_EXPORTER_OTLP_HEADERS` per spec: comma-separated
 * `key=value` pairs. E.g. `Authorization=Bearer abc,X-Tenant=foo`.
 */
function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
