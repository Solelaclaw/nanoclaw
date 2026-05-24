/**
 * Default reply routing for this session — written by the host on every
 * container wake (see src/session-manager.ts `writeSessionRouting`).
 *
 * Read by the MCP tools as the default destination for outbound messages
 * when the agent doesn't specify an explicit `to`. This is what makes
 * "agent replies in the thread it's currently in" work: the router strips
 * or preserves thread_id based on the adapter's thread support, and we
 * just read the fixed routing the host committed for this session.
 */
import { getInboundDb } from './connection.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function getSessionRouting(): SessionRouting {
  const db = getInboundDb();
  try {
    const row = db
      .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
      .get() as SessionRouting | undefined;
    if (row) return row;
  } catch {
    // Table may not exist on an older session DB — fall through to defaults
  }
  return { channel_type: null, platform_id: null, thread_id: null };
}

/**
 * Refresh session_routing to reflect the channel/platform of the message
 * currently being processed.
 *
 * Why this exists: the host writes session_routing at container *spawn*
 * time using the session's `messaging_group_id` (the channel that first
 * created the session). For `session_mode='agent-shared'` sessions —
 * where the same session serves messages from multiple channels (web +
 * Telegram + WhatsApp for the same agent) — that means the routing
 * stays pinned to the FIRST channel that ever spawned the container.
 *
 * MCP tools that need to act *as the message sender* (e.g. the
 * solelaclawde campaigns bridge sending `X-Acting-Platform-Id` to scope
 * writes to the right Supabase user) would otherwise read a stale
 * platform_id and 404 against the wrong assistant row.
 *
 * The poll-loop calls this at the top of every batch with the current
 * inbound message's metadata so any MCP tool fired downstream
 * reads-after-write correctly.
 */
export function refreshSessionRouting(routing: {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}): void {
  // No-op if all fields are null (nothing to refresh) — preserves the
  // host's spawn-time defaults rather than blanking them.
  if (!routing.platformId && !routing.channelType && !routing.threadId) return;
  const db = getInboundDb();
  try {
    db.prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, $channel, $platform, $thread)
       ON CONFLICT(id) DO UPDATE SET
         channel_type = excluded.channel_type,
         platform_id  = excluded.platform_id,
         thread_id    = excluded.thread_id`,
    ).run({
      $channel: routing.channelType,
      $platform: routing.platformId,
      $thread: routing.threadId,
    });
  } catch {
    // Table may not exist on older session DBs — silently no-op rather
    // than crash the poll loop. The MCP tool will fall back to whatever
    // getSessionRouting() returns (defaults).
  }
}
