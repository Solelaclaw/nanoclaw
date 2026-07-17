/**
 * Regression tests for the chat-history timestamp skew.
 *
 * inbound.db stores `new Date().toISOString()`; outbound.db stores SQLite
 * `datetime('now')`. Both are UTC, but only the first says so. The old
 * code ran both through a bare `Date.parse`, which reads the unmarked
 * SQLite shape as local time — so on a non-UTC host every assistant row
 * shifted by the host's offset and the agent side of the transcript
 * sorted ahead of the user side.
 *
 * These tests pin the host to a non-UTC zone on purpose: under TZ=UTC the
 * bug is invisible and they'd pass against the broken code too.
 */
import { describe, it, expect } from 'vitest';

import { parseSessionTimestamp } from './web.js';

/** Same instant, as each DB would store it. */
const INSTANT_UTC_MS = Date.UTC(2026, 6, 17, 12, 53, 0);
const AS_INBOUND = '2026-07-17T12:53:00.000Z'; // toISOString()
const AS_OUTBOUND = '2026-07-17 12:53:00'; // SQLite datetime('now')

describe('parseSessionTimestamp', () => {
  it('reads the ISO-8601 (inbound) shape as UTC', () => {
    expect(parseSessionTimestamp(AS_INBOUND)).toBe(INSTANT_UTC_MS);
  });

  it('reads the SQLite (outbound) shape as UTC, not local', () => {
    expect(parseSessionTimestamp(AS_OUTBOUND)).toBe(INSTANT_UTC_MS);
  });

  it('resolves both shapes of the same instant identically', () => {
    // The actual bug: these two drifted apart by the host's UTC offset.
    expect(parseSessionTimestamp(AS_OUTBOUND)).toBe(parseSessionTimestamp(AS_INBOUND));
  });

  it('handles SQLite fractional seconds', () => {
    expect(parseSessionTimestamp('2026-07-17 12:53:00.500')).toBe(INSTANT_UTC_MS + 500);
  });

  it('honours an explicit non-UTC offset rather than forcing Z', () => {
    // +03:00 means 09:53Z — must not be re-stamped as 12:53Z.
    expect(parseSessionTimestamp('2026-07-17T12:53:00+03:00')).toBe(INSTANT_UTC_MS - 3 * 3600_000);
  });

  it('returns NaN for junk instead of epoch zero', () => {
    // The old `|| 0` turned these into 1970 and sorted them to the top.
    for (const junk of ['', 'not-a-date', undefined as unknown as string]) {
      expect(Number.isNaN(parseSessionTimestamp(junk))).toBe(true);
    }
  });

  it('orders a real transcript chronologically, not by role', () => {
    // A conversation alternating user/assistant, each side stored in its
    // own format. Under the old parse on a UTC+N host, every assistant row
    // sorted before every user row — exactly the reported symptom.
    const rows = [
      { role: 'user', ts: '2026-07-17T12:00:00.000Z' },
      { role: 'assistant', ts: '2026-07-17 12:00:05' },
      { role: 'user', ts: '2026-07-17T12:01:00.000Z' },
      { role: 'assistant', ts: '2026-07-17 12:01:05' },
    ];

    const sorted = [...rows]
      .sort((a, b) => parseSessionTimestamp(a.ts) - parseSessionTimestamp(b.ts))
      .map((r) => r.role);

    expect(sorted).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
