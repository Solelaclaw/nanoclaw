import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * V2.6 — flip every `messaging_group_agents.session_mode = 'shared'` to
 * `'agent-shared'` for SoleLaClawde-style agent groups (folder prefix
 * `web-`).
 *
 * Why:
 *   The default `'shared'` value means "one session per messaging_group" —
 *   each channel (web, WhatsApp, Telegram) gets its own session, and
 *   therefore its own conversational memory. For a single-user multi-
 *   channel assistant, this is wrong: the user expects one continuous
 *   memory regardless of where they're typing from.
 *
 *   `'agent-shared'` is the right value: one session per agent_group,
 *   reused across all messaging_groups wired to that agent. See
 *   `src/session-manager.ts::resolveSession` (lines 87-89) for the
 *   exact semantics.
 *
 * Scope:
 *   Only agent_groups with `folder LIKE 'web-%'` are flipped. That's the
 *   namespace SoleLaClawde uses for its per-user provisioning (the web
 *   channel calls them `web-<userId>`). Any other agent_group living on
 *   this install (init-first-agent owner, operator-pairing groups) keeps
 *   whatever session_mode it was set with — we don't have a strong
 *   opinion about non-SoleLaClawde wirings.
 *
 * Companion:
 *   The four callsites in `src/channels/web.ts` that previously hardcoded
 *   `session_mode: 'shared'` for new wirings have been updated to
 *   `'agent-shared'`. New users will never need this migration.
 *
 * Caveat — orphan sessions:
 *   Users who were already on `'shared'` mode and had multiple sessions
 *   (one per channel) will, on their next message, have NanoClaw call
 *   `findSessionByAgentGroup` and pick ONE of the existing sessions as
 *   the shared one. The others become orphaned — their `session_state`
 *   is not lost on disk but the agent won't route to them anymore. In
 *   practice that means a partial memory loss equivalent to the content
 *   of the orphaned sessions; the agent will rebuild from the new
 *   primary session going forward. We accept that as the right trade-
 *   off for a coherent multi-channel experience.
 */
export const migration016: Migration = {
  version: 16,
  name: 'default-agent-shared-session-mode',
  up(db: Database.Database) {
    db.prepare(
      `UPDATE messaging_group_agents
         SET session_mode = 'agent-shared'
       WHERE session_mode = 'shared'
         AND agent_group_id IN (
           SELECT id FROM agent_groups WHERE folder LIKE 'web-%'
         )`,
    ).run();
  },
};
