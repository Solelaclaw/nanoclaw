/**
 * CRUD for `pending_pairings`. See migration 017 for the table's role
 * in the pairing-code identity flow.
 *
 * Codes are short-lived (15 min default) and only ever claimed once.
 * Sweeping expired rows is deferred to the host's existing 60s sweep
 * loop — `purgeExpiredPairings` is called from there.
 */
import { getDb } from './connection.js';

/** How a code is rendered to the user — uppercase alphanumeric, no
 * homoglyph-prone chars (0/O, 1/I/l). Long enough to defeat guessing,
 * short enough to type by hand if the deep link fails. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** Default time-to-claim for a freshly issued code. The web UI polls
 * status while the user moves between tabs, so 15 minutes is plenty
 * for normal use and short enough that a leaked code expires before
 * it can be reused maliciously. */
export const DEFAULT_PAIRING_TTL_MS = 15 * 60 * 1000;

export interface PendingPairing {
  code: string;
  channel_type: string;
  agent_group_id: string;
  supabase_user_id: string | null;
  display_name: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_platform_id: string | null;
}

export interface CreatePairingInput {
  channelType: string;
  agentGroupId: string;
  supabaseUserId?: string | null;
  displayName?: string | null;
  ttlMs?: number;
}

export interface ClaimResult {
  ok: boolean;
  reason?: 'not_found' | 'expired' | 'already_claimed' | 'wrong_channel';
  pairing?: PendingPairing;
}

/** Generate a fresh code that doesn't collide with any unclaimed row.
 * In practice with 31^6 ≈ 887M options and short TTLs collisions are
 * vanishingly rare, but we retry on the off chance. */
function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** Insert a fresh pairing row. Retries on the PK collision (extremely
 * unlikely but handled for completeness). */
export function createPairing(input: CreatePairingInput): PendingPairing {
  const db = getDb();
  const now = Date.now();
  const ttl = input.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  const created_at = new Date(now).toISOString();
  const expires_at = new Date(now + ttl).toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      db.prepare(
        `INSERT INTO pending_pairings
           (code, channel_type, agent_group_id, supabase_user_id,
            display_name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        code,
        input.channelType,
        input.agentGroupId,
        input.supabaseUserId ?? null,
        input.displayName ?? null,
        created_at,
        expires_at,
      );
      return {
        code,
        channel_type: input.channelType,
        agent_group_id: input.agentGroupId,
        supabase_user_id: input.supabaseUserId ?? null,
        display_name: input.displayName ?? null,
        created_at,
        expires_at,
        claimed_at: null,
        claimed_platform_id: null,
      };
    } catch (err) {
      // Only swallow PK-collision errors; anything else (FK violation,
      // missing column) is a real problem we want to surface.
      if (!String(err).includes('UNIQUE')) throw err;
    }
  }
  throw new Error('pending_pairings: code generation collided 5 times — alphabet exhausted?');
}

export function getPairing(code: string): PendingPairing | null {
  const row = getDb()
    .prepare(
      `SELECT code, channel_type, agent_group_id, supabase_user_id,
              display_name, created_at, expires_at, claimed_at, claimed_platform_id
         FROM pending_pairings
        WHERE code = ?`,
    )
    .get(code) as PendingPairing | undefined;
  return row ?? null;
}

/**
 * Atomically mark a code as claimed. The router calls this when an
 * inbound message matches a known unclaimed, unexpired code on the
 * correct channel. Returns the bound pairing so the caller can use
 * its agent_group_id to wire the messaging_group.
 */
export function claimPairing(code: string, channelType: string, platformId: string): ClaimResult {
  const db = getDb();
  const row = getPairing(code);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.channel_type !== channelType) return { ok: false, reason: 'wrong_channel' };
  if (row.claimed_at) return { ok: false, reason: 'already_claimed' };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, reason: 'expired' };

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE pending_pairings
          SET claimed_at = ?, claimed_platform_id = ?
        WHERE code = ?
          AND claimed_at IS NULL`,
    )
    .run(now, platformId, code);

  if (result.changes === 0) {
    // Concurrent claim raced us — treat as already claimed.
    return { ok: false, reason: 'already_claimed' };
  }
  return {
    ok: true,
    pairing: { ...row, claimed_at: now, claimed_platform_id: platformId },
  };
}

/** Called from the host's sweep loop. Removes expired-and-never-
 * claimed rows so the table stays small. Claimed rows are kept for
 * audit. */
export function purgeExpiredPairings(): number {
  const result = getDb()
    .prepare(
      `DELETE FROM pending_pairings
        WHERE claimed_at IS NULL
          AND expires_at < ?`,
    )
    .run(new Date().toISOString());
  return result.changes;
}

/**
 * Extract a pairing code from an inbound message body. Matches:
 *   - `/start <CODE>`  (Telegram's standard deep-link send)
 *   - bare `<CODE>` on its own line (other channels — WhatsApp,
 *     Signal, Discord — that don't have /start semantics)
 *
 * Returns null if nothing recognizable. The caller still needs to
 * verify the code exists + is unclaimed before treating this as
 * a pairing attempt.
 */
export function extractPairingCode(messageText: string): string | null {
  const trimmed = messageText.trim();
  if (!trimmed) return null;

  // Telegram deep-link form: `/start XK7P9M` or `/start@botname XK7P9M`
  const startMatch = trimmed.match(/^\/start(?:@\w+)?\s+([A-Z0-9]{6,8})\s*$/);
  if (startMatch) return startMatch[1].toUpperCase();

  // Bare code on its own line — only if the whole message IS the code.
  // We deliberately don't search inside longer messages to avoid
  // false positives ("call me at 234567" → '234567').
  const bareMatch = trimmed.match(/^([A-Z0-9]{6,8})$/i);
  if (bareMatch) return bareMatch[1].toUpperCase();

  return null;
}
