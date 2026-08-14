/**
 * To-dos MCP tools — agent → SoleLaClawde web bridge.
 *
 * The To-dos SolelApp is the user's shared task list (Apps folder in
 * the web UI). These tools are how the agent WORKS that list instead of
 * dumping markdown task lists into chat:
 *   - `todo_list`     — read the user's current list (open + done)
 *   - `todo_add`      — add one or more items (server-deduped by text)
 *   - `todo_complete` — mark an item done (or reopen it)
 *
 * Same bridge + auth as the campaigns tools: `/api/internal/agent/*` on
 * the web app, service token `SOLELACLAWDE_AGENT_API_TOKEN` + the
 * X-Acting-Platform-Id header carrying the session's NanoClaw platform
 * id. Soft-fail: without the env config the tools return a structured
 * error so the agent degrades to chat-only task lists.
 */
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function bridgeConfig(): { url: string; token: string } | null {
  const url = process.env.SOLELACLAWDE_API_URL;
  const token = process.env.SOLELACLAWDE_AGENT_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

function actingPlatformId(): string | null {
  const r = getSessionRouting();
  return r.platform_id ?? null;
}

async function bridgeFetch(
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown } = { method: 'GET' },
): Promise<{ status: number; data: unknown }> {
  const cfg = bridgeConfig();
  if (!cfg) {
    throw new Error(
      'SoleLaClawde bridge not configured — set SOLELACLAWDE_AGENT_API_TOKEN + SOLELACLAWDE_API_URL on the agent container. Fall back to a plain markdown task list in chat.',
    );
  }
  const pid = actingPlatformId();
  if (!pid) {
    throw new Error('No platform id on this session — cannot identify the acting user.');
  }
  const res = await fetch(`${cfg.url}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'X-Acting-Platform-Id': pid,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, data };
}

// ─── todo_list ───────────────────────────────────────────────────────────

export const todoList: McpToolDefinition = {
  tool: {
    name: 'todo_list',
    description:
      "Read the user's shared to-do list (the To-dos app they see under Apps in the web UI). Call this whenever the user asks what's on their plate, what's pending, or before planning work — their list is shared state, not something to reconstruct from chat history. Returns { todos: [{ id, text, done, source, createdAt }] }.",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    try {
      const { status, data } = await bridgeFetch('/api/internal/agent/todos', { method: 'GET' });
      if (status >= 400) {
        return err(`todo_list ${status}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return ok(JSON.stringify(data));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

// ─── todo_add ────────────────────────────────────────────────────────────

export const todoAdd: McpToolDefinition = {
  tool: {
    name: 'todo_add',
    description:
      "Add action items to the user's shared to-do list (the To-dos app). Use this INSTEAD of writing markdown task lists in chat whenever you identify things the user (or you) must do — open items from a plan, follow-ups after an inbox/calendar review, next steps the user agreed to. Items are deduped server-side by text, so re-planning is safe. Keep each item short and actionable ('Accept the Beeswax sync for Tuesday'). Returns the updated list; mention in chat that you added them ('Added 2 items to your To-dos').",
    inputSchema: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          description: '1–50 items to add.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Short, actionable item text.' },
              done: { type: 'boolean', description: 'Rarely needed — pre-completed item.' },
            },
            required: ['text'],
          },
        },
      },
      required: ['items'],
    },
  },
  async handler(args) {
    try {
      const items = args.items as Array<{ text: string; done?: boolean }>;
      if (!Array.isArray(items) || items.length === 0) return err('items is required');
      const { status, data } = await bridgeFetch('/api/internal/agent/todos', {
        method: 'POST',
        body: { items },
      });
      if (status >= 400) {
        return err(`todo_add ${status}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      log(`todo_add: ok ${JSON.stringify(data).slice(0, 120)}`);
      return ok(JSON.stringify(data));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

// ─── todo_complete ───────────────────────────────────────────────────────

export const todoComplete: McpToolDefinition = {
  tool: {
    name: 'todo_complete',
    description:
      "Mark an item on the user's shared to-do list as done (or reopen it with done=false). Call it right after you finish something that's on the list — e.g. you accepted the invite, sent the email, produced the report — so the list reflects reality without the user having to tidy it. Get ids from todo_list.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo id from todo_list.' },
        done: { type: 'boolean', description: 'Default true. false reopens the item.' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    try {
      const id = args.id as string;
      if (!id?.trim()) return err('id is required');
      const done = (args.done as boolean | undefined) ?? true;
      const { status, data } = await bridgeFetch(
        `/api/internal/agent/todos/${encodeURIComponent(id.trim())}`,
        { method: 'PATCH', body: { done } },
      );
      if (status >= 400) {
        return err(`todo_complete ${status}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return ok(JSON.stringify(data));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([todoList, todoAdd, todoComplete]);
