/**
 * Custom skill markdown + persona on container_configs.
 *
 * V3 — Solela marketplace integration. When a buyer subscribes to a
 * marketplace agent template, the author's hand-authored skill body
 * and persona text need to land on the buyer's container so the
 * agent actually speaks/behaves like the published template — not
 * just as a generic agent with built-in skills enabled.
 *
 * Two nullable TEXT columns:
 *   - custom_skill_md     — author-authored skill body (markdown)
 *   - custom_persona      — author-authored persona / voice fragment
 *
 * Read by `composeGroupClaudeMd` at every container spawn to inject
 * the content into the agent's CLAUDE.md as additional fragments,
 * alongside the standard skills.
 *
 * Both default NULL — existing agent groups continue to behave
 * exactly as today. Only marketplace-provisioned agents populate
 * these columns.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'custom-skill-and-persona',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN custom_skill_md TEXT;
      ALTER TABLE container_configs ADD COLUMN custom_persona TEXT;
    `);
  },
};
