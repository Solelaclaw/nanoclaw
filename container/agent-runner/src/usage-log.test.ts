/**
 * Tests for the SDK-result → usage-record extraction. We mock fs at the
 * module level so the actual /workspace/usage.jsonl write is captured
 * in-memory and asserted on per case.
 */
import { describe, expect, it, mock, beforeEach } from 'bun:test';

let appended: string[] = [];

// Mock fs.appendFileSync so we capture writes without touching disk.
mock.module('fs', () => ({
  default: {
    appendFileSync: (path: string, data: string) => {
      appended.push(data);
    },
  },
  appendFileSync: (_path: string, data: string) => {
    appended.push(data);
  },
}));

import { recordUsageFromSdkResult } from './usage-log.js';

beforeEach(() => {
  appended = [];
});

describe('recordUsageFromSdkResult', () => {
  it('appends one JSONL line for a success result', () => {
    recordUsageFromSdkResult({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.01234,
      duration_ms: 1500,
      duration_api_ms: 1200,
      num_turns: 3,
      usage: {
        input_tokens: 1280,
        output_tokens: 340,
        cache_read_input_tokens: 4800,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 1280,
          outputTokens: 340,
          cacheReadInputTokens: 4800,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.01234,
        },
      },
    });
    expect(appended.length).toBe(1);
    const line = appended[0];
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.subtype).toBe('success');
    expect(parsed.costUsd).toBe(0.01234);
    expect(parsed.inputTokens).toBe(1280);
    expect(parsed.outputTokens).toBe(340);
    expect(parsed.cacheReadTokens).toBe(4800);
    expect(parsed.numTurns).toBe(3);
    expect(parsed.byModel['claude-sonnet-4-5'].costUsd).toBe(0.01234);
    expect(typeof parsed.ts).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  it('records mixed-model usage with separate buckets', () => {
    recordUsageFromSdkResult({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.5,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {
        'claude-opus-4': {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 1,
          costUSD: 0.4,
        },
        'claude-sonnet-4-5': {
          inputTokens: 50,
          outputTokens: 80,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.1,
        },
      },
    });
    const parsed = JSON.parse(appended[0]);
    expect(Object.keys(parsed.byModel).sort()).toEqual([
      'claude-opus-4',
      'claude-sonnet-4-5',
    ]);
    expect(parsed.byModel['claude-opus-4'].costUsd).toBe(0.4);
    expect(parsed.byModel['claude-sonnet-4-5'].costUsd).toBe(0.1);
    expect(parsed.webSearchRequests).toBe(1);
  });

  it('ignores non-result messages', () => {
    recordUsageFromSdkResult({ type: 'system', subtype: 'init' });
    recordUsageFromSdkResult({ type: 'assistant', content: 'hello' });
    recordUsageFromSdkResult(null);
    recordUsageFromSdkResult(undefined);
    recordUsageFromSdkResult('string');
    expect(appended.length).toBe(0);
  });

  it('tolerates a sparse result message (missing fields default to 0)', () => {
    recordUsageFromSdkResult({ type: 'result' });
    expect(appended.length).toBe(1);
    const parsed = JSON.parse(appended[0]);
    expect(parsed.costUsd).toBe(0);
    expect(parsed.inputTokens).toBe(0);
    expect(parsed.outputTokens).toBe(0);
    expect(parsed.cacheReadTokens).toBe(0);
    expect(parsed.byModel).toEqual({});
  });
});
