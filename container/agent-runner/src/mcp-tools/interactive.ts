/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 */
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
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

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires.\n\nProvide a short card title (e.g. "Send email to Gavriel?") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.\n\nWHEN THE QUESTION GATES AN ACTION (sending an email, posting a message, creating a meeting, …), ALWAYS include the action content so the user can see WHAT they\'re confirming before they click. Use whichever of these fits best:\n  • `body` — the drafted text the agent generated (the email body, the message draft, the meeting agenda). Plain text, no markdown wrappers.\n  • `details` — labelled key/value pairs the user needs to see at a glance (e.g. { "To": "gavriel@…", "Subject": "Re: roadmap", "When": "Fri 14:30" }). Use this for structured fields like recipients, dates, amounts.\n  • `subtitle` — short one-liner shown under the title (e.g. "to gavriel@nanoco.ai"). Use ONLY for a single piece of trivial context that doesn\'t belong in details.\n  • `payload` — for credentialed HTTP calls only. OneCLI-style { method, host, path, bodyPreview } — the web side vendor-parses Gmail / Calendar / Slack / WhatsApp / Stripe etc. automatically.\n\nA card that asks "Send this email? [Yes] [No]" with no body/details is a black-box ask — the user will reject or stall because they can\'t see what they\'re approving. Always show your work.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for the user to choose from (string or {label, selectedLabel?, value?})',
        },
        subtitle: {
          type: 'string',
          description:
            'Optional one-line subtitle shown under the title (e.g. "to gavriel@nanoco.ai"). Single piece of trivial context only — anything richer goes in details/body/payload.',
        },
        body: {
          type: 'string',
          description:
            'Optional free-form text body (e.g. the email body, message draft, meeting agenda). Rendered as a scrollable preview block above the buttons.',
        },
        details: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional `{ label: value }` map of fields to show as labelled rows above the buttons (e.g. `{ "To": "gavriel@…", "Subject": "Re: roadmap" }`). Each pair renders on one line so prefer short values.',
        },
        payload: {
          type: 'object',
          properties: {
            method: { type: 'string' },
            host: { type: 'string' },
            path: { type: 'string' },
            bodyPreview: { type: 'string' },
            agent: {
              type: 'object',
              properties: { name: { type: 'string' } },
            },
          },
          description:
            'Optional OneCLI-style HTTP request payload — when present, the web side runs its vendor parser to render Gmail/Calendar/Slack/etc. fields automatically. Use this when the question gates a credentialed HTTP call whose body is rich enough to benefit from vendor-aware extraction.',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();

    // Collect optional context fields — only emit ones that were
    // actually set so nanoclaw can decide between "no context" and
    // "agent shipped an empty string". Forward-compatible: existing
    // ask_user_question call sites that don't pass these still work.
    const subtitle = typeof args.subtitle === 'string' && args.subtitle ? args.subtitle : undefined;
    const body = typeof args.body === 'string' && args.body ? args.body : undefined;
    const details =
      args.details && typeof args.details === 'object' && !Array.isArray(args.details)
        ? (args.details as Record<string, string>)
        : undefined;
    const payload =
      args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
        ? (args.payload as Record<string, unknown>)
        : undefined;

    // Write question card to outbound.db
    writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        title,
        question,
        options,
        // Spread context fields at the top level — delivery.ts on
        // the nanoclaw side reads them by name to populate the
        // pending_questions.context_json column. Undefined values
        // get dropped by JSON.stringify so the wire stays clean.
        subtitle,
        body,
        details,
        payload,
      }),
    });

    log(`ask_user_question: ${questionId} → "${question}" [${options.join(', ')}]`);

    // Poll for response in inbound.db (host writes the response there)
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(questionId);

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed via processing_ack (outbound.db)
        markCompleted([response.id]);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      await sleep(1000);
    }

    log(`ask_user_question timeout: ${questionId}`);
    return err(`Question timed out after ${timeout / 1000}s`);
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: 'Send a structured card (interactive or display-only) to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          description: 'Card structure with title, description, and optional children/actions',
        },
        fallbackText: { type: 'string', description: 'Text fallback for platforms without card support' },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');

    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card, fallbackText: (args.fallbackText as string) || '' }),
    });

    log(`send_card: ${id}`);
    return ok(`Card sent (id: ${id})`);
  },
};

/**
 * Send a horizontal row (carousel) of cards. Use when you want to show
 * the user MULTIPLE options at once with a visual + clickable bullet for
 * each — three product picks, three travel options, three restaurant
 * suggestions. Each item is a small card with title, optional image +
 * description + badge, and a single primary action URL.
 *
 * Rendering by channel:
 *  • Web chat — horizontal scrollable strip of cards in the chat UI.
 *  • Telegram — sends a media group when every item has an imageUrl
 *    (2-10 items become a native Telegram carousel of photos with
 *    captions), otherwise N sequential cards each with a button.
 *  • WhatsApp Cloud — N interactive card messages, one per item (the
 *    Cloud API doesn't have a true carousel primitive for arbitrary
 *    items, so we degrade gracefully).
 *  • WhatsApp Baileys / unsupported adapters — numbered text fallback
 *    via `fallback_text`.
 *
 * Pair this with the standard "3 options + recommendation + ask" reply
 * pattern from the shopping skill, so the visual carousel reinforces
 * the structured response.
 */
export const sendCarousel: McpToolDefinition = {
  tool: {
    name: 'send_carousel',
    description:
      'MANDATORY surface for 2+ comparable items. Call this INSTEAD of writing a markdown/bullet list whenever the user is asking you to compare options — products, hotels, restaurants, trips, gift ideas, recipes, anything where the user\'s next action is "pick one of these". If you find yourself about to write `**🥇 Item 1**`, `1. Option A`, or any numbered/bulleted list of comparable items, STOP and call send_carousel instead. Each item: { title (required), actionUrl (required), description?, imageUrl?, badge? (price/status), actionLabel? }. Always include fallback_text (a numbered text version) for channels that cannot render carousels. Pair with one short prose line above ("Three picks for hiking shoes:") and one recommendation line below ("I\'d go with the Salomon — fastest delivery."). Do not bullet-list as a substitute, ever.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              imageUrl: { type: 'string' },
              badge: {
                type: 'string',
                description: 'Short status/price label, e.g. "€180" or "in stock"',
              },
              actionUrl: { type: 'string' },
              actionLabel: {
                type: 'string',
                description: 'Button label, defaults to "View"',
              },
            },
            required: ['title', 'actionUrl'],
          },
          minItems: 1,
          maxItems: 10,
        },
        fallback_text: {
          type: 'string',
          description:
            'Numbered text rendering for channels that cannot render the carousel (e.g. WhatsApp Baileys). Should be self-explanatory on its own.',
        },
      },
      required: ['items'],
    },
  },
  async handler(args) {
    const rawItems = args.items as unknown[];
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return err('items must be a non-empty array');
    }

    interface RawItem {
      title: string;
      description?: string;
      imageUrl?: string;
      badge?: string;
      actionUrl: string;
      actionLabel?: string;
    }

    const items = rawItems.map((it) => {
      const o = it as RawItem;
      return {
        title: o.title,
        description: o.description,
        imageUrl: o.imageUrl,
        badge: o.badge,
        actionUrl: o.actionUrl,
        actionLabel: o.actionLabel ?? 'View',
      };
    });

    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'carousel',
        items,
        fallbackText: (args.fallback_text as string) || '',
      }),
    });

    log(`send_carousel: ${id} items=${items.length}`);
    return ok(`Carousel sent (id: ${id}, ${items.length} items)`);
  },
};

registerTools([askUserQuestion, sendCard, sendCarousel]);
