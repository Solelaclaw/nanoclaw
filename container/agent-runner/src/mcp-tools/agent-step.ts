/**
 * `agent_step` MCP tool — emits a progress step to the user-visible UI.
 *
 * The agent calls this before each non-trivial action ("Sourcing
 * prospects from Apollo", "Drafting email 3 of 5", "Saving to your
 * dashboard"). Channels render the steps progressively:
 *
 *   - Web: structured step block, the running step pulses, prior
 *     steps show as done with a check. When the next regular
 *     message (text / card / carousel) arrives, the block auto-
 *     collapses to a one-line summary the user can re-expand.
 *   - Telegram / Slack / Discord (any chat-sdk channel): edit a
 *     pinned status message in place — the steps stack as they
 *     arrive, no wrapper text.
 *   - WhatsApp (Baileys, no reliable edit): degrade to a short
 *     plain-text "🔍 <step>" line per call.
 *
 * Wire format: emits a `messages_out` row with kind=`step` and
 * content `{ type: 'step', title }`. Channels parse and render.
 *
 * The agent does NOT signal "done" explicitly. The presence of the
 * NEXT non-step outbound message (the actual reply: text / carousel /
 * card) is the close signal — channels collapse their step UI then.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const agentStep: McpToolDefinition = {
  tool: {
    name: 'agent_step',
    description:
      'Emit a short progress step the user sees in the chat surface — like Perplexity\'s "Searching the web…" pulse. Call this BEFORE every non-trivial action (tool call >2s, multi-step generation, anything that would otherwise leave the user staring at a silent typing dot). Keep titles tight + in the present continuous ("Searching Apollo for VPs", "Drafting email 3 of 5", "Saving to your dashboard"). The user-facing reply (text / send_carousel / send_card) that follows the steps auto-collapses the step block — you do NOT need to send a final "done" step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description:
            'Short present-continuous label for the current action. Visible to the user. Max ~80 chars.',
        },
      },
      required: ['title'],
    },
  },
  async handler(args) {
    const title = (args.title as string | undefined)?.trim();
    if (!title) return err('title is required');
    if (title.length > 200) return err('title too long (max 200 chars)');

    const r = getSessionRouting();
    const id = generateId();
    writeMessageOut({
      id,
      kind: 'step',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'step', title }),
    });
    log(`agent_step: ${title}`);
    return ok(`step emitted: ${title}`);
  },
};

registerTools([agentStep]);
