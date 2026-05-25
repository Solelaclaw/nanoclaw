/**
 * Pairing-code identity flow — replaces the per-stranger approval queue
 * with a code-based "the user proves who they are by passing a one-time
 * token from web to channel" model.
 *
 * Flow:
 *   1. Web app calls POST /admin/channels/pair-start with agentGroupId
 *      → row inserted here with a 6-char code, 15-min expiry
 *   2. User taps a deep link (e.g. t.me/<bot>?start=<code>) or copies
 *      the code into the channel
 *   3. Router sees the code on inbound, looks it up in this table, and
 *      atomically creates the messaging_groups + messaging_group_agents
 *      wiring, marks `claimed_at` + `claimed_platform_id`
 *   4. Web app polls GET /admin/channels/pair-status?code=… and sees
 *      `claimed_at` set → redirects user to /chat
 *
 * Why a dedicated table (and not extending pending_*_approvals):
 *   - Approvals model a human "yes/no" decision. Pairings are
 *     fully automated identity proofs — different lifecycle, different
 *     resolve mechanism. Conflating them muddies the schema and the
 *     UI (admins shouldn't see pairings in their approval inbox).
 *   - Codes are short-lived and high-cardinality; their own PK
 *     makes lookup at routing time cheap.
 *
 * `channel_type` is denormalized into the row so the router can
 * cross-check that a code generated for Telegram isn't being claimed
 * via a WhatsApp message (or vice versa).
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'pending-pairings',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_pairings (
        code                  TEXT PRIMARY KEY,
        channel_type          TEXT NOT NULL,
        agent_group_id        TEXT NOT NULL REFERENCES agent_groups(id),
        supabase_user_id      TEXT,                  -- web-app user, optional
        display_name          TEXT,                  -- shown back on claim confirmation
        created_at            TEXT NOT NULL,
        expires_at            TEXT NOT NULL,
        claimed_at            TEXT,                  -- set on successful claim
        claimed_platform_id   TEXT                   -- the channel-side identity that claimed it
      );
      CREATE INDEX IF NOT EXISTS idx_pending_pairings_expires
        ON pending_pairings(expires_at);
      CREATE INDEX IF NOT EXISTS idx_pending_pairings_agent
        ON pending_pairings(agent_group_id);
    `);
  },
};
