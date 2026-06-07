/**
 * Persist optional context fields on `pending_questions` so the
 * `ask_user_question` MCP tool can ship a human-readable preview of
 * the action it's gating — typically the email body / meeting
 * details / message draft the agent generated — alongside the
 * title + options.
 *
 * Why: before this, the web question card rendered title + buttons
 * only. The user was being asked "Send updated email to Gavriel?
 * [Send] [Edit first] [Cancel]" with no way to see WHAT email was
 * about to go out. The web client already supports rendering the
 * extra context (see `apps/web/src/app/chat/_components/question-
 * card.tsx`, `subtitle` / `body` / `details` / `payload` props);
 * this migration is the storage half so the round-trip from
 * container → pending_questions → /admin/agent-questions/pending
 * → web actually carries the fields.
 *
 * One column, JSON blob — keeps schema flexible (add new context
 * shapes without a fresh migration) and matches the storage pattern
 * already used for `options_json`. NULL on every existing row, no
 * default, so back-compat is automatic.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'question-context',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE pending_questions ADD COLUMN context_json TEXT`);
  },
};
