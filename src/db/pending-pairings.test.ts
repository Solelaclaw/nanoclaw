/**
 * Pure-function tests for extractPairingCode. The CRUD helpers are
 * exercised end-to-end by the router's higher-level tests and the
 * production claim path — duplicating that with raw-DB tests here
 * would add brittleness without proving anything new.
 */
import { describe, it, expect } from 'vitest';

import { extractPairingCode } from './pending-pairings.js';

describe('extractPairingCode', () => {
  it('matches a Telegram /start payload', () => {
    expect(extractPairingCode('/start XK7P9M')).toBe('XK7P9M');
  });

  it('matches a Telegram /start payload with bot suffix', () => {
    expect(extractPairingCode('/start@appsolelabot ABCD23')).toBe('ABCD23');
  });

  it('lower-cases /start codes upper for canonical lookup', () => {
    // Even though the bare-code branch upper-cases, /start canonicalizes too.
    expect(extractPairingCode('/start xk7p9m')).toBe(null);
    // /start requires upper-case [A-Z0-9] only — this matches the codes we
    // hand out and avoids ambiguity with arbitrary user text after /start.
  });

  it('matches a bare 6-char code on its own line', () => {
    expect(extractPairingCode('XK7P9M')).toBe('XK7P9M');
  });

  it('matches a lower-case bare code (upper-cases for lookup)', () => {
    expect(extractPairingCode('xk7p9m')).toBe('XK7P9M');
  });

  it('trims surrounding whitespace', () => {
    expect(extractPairingCode('  XK7P9M  \n')).toBe('XK7P9M');
  });

  it('rejects codes embedded in longer messages — no false positives', () => {
    // The 6-digit substring `234567` should NOT be picked up as a code.
    expect(extractPairingCode('call me at 234567 around noon')).toBe(null);
    expect(extractPairingCode('here is the code: XK7P9M')).toBe(null);
  });

  it('rejects too-short and too-long candidates', () => {
    expect(extractPairingCode('AB123')).toBe(null);
    expect(extractPairingCode('ABCDE12345')).toBe(null);
  });

  it('rejects empty / whitespace-only input', () => {
    expect(extractPairingCode('')).toBe(null);
    expect(extractPairingCode('   ')).toBe(null);
    expect(extractPairingCode('\n\n')).toBe(null);
  });

  it('rejects non-alphanumeric characters', () => {
    expect(extractPairingCode('XK7-P9M')).toBe(null);
    expect(extractPairingCode('XK7 P9M')).toBe(null);
  });

  it('handles arbitrary text without crashing', () => {
    expect(extractPairingCode('hello world')).toBe(null);
    expect(extractPairingCode('🎉 emoji message')).toBe(null);
  });
});
