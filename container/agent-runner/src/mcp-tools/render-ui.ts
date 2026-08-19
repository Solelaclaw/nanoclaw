/**
 * UI rendering MCP tool: render_ui.
 *
 * Emits a constrained, typed JSON vocabulary for web-native UI surfaces.
 * Other channels fall back to fallbackText in the host delivery layer.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

type UiSpec = BoardSpec | ChipSpec;

interface BoardSpec {
  kind: 'board';
  title: string;
  columns: BoardColumnSpec[];
}

interface BoardColumnSpec {
  key: 'running' | 'waiting' | 'done';
  label: string;
  tasks: TaskSpec[];
}

interface TaskSpec {
  title: string;
  sub?: string;
  progress?: number;
  actions?: ActionSpec[];
}

interface ActionSpec {
  label: string;
  style?: 'primary' | 'ghost';
  reply?: string;
  approvalId?: string;
}

interface ChipSpec {
  kind: 'chip';
  icon?: 'clock' | 'check';
  label: string;
  reply?: string;
}

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

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or fewer`);
  return trimmed;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or fewer`);
  return trimmed;
}

function isBoardColumnKey(value: unknown): value is BoardColumnSpec['key'] {
  return value === 'running' || value === 'waiting' || value === 'done';
}

function validateAction(value: unknown): ActionSpec {
  if (!value || typeof value !== 'object') throw new Error('action must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.style !== undefined && raw.style !== 'primary' && raw.style !== 'ghost') {
    throw new Error('action.style must be primary or ghost');
  }
  return {
    label: requiredString(raw.label, 'action.label', 48),
    style: raw.style as 'primary' | 'ghost' | undefined,
    reply: optionalString(raw.reply, 'action.reply', 500),
    approvalId: optionalString(raw.approvalId, 'action.approvalId', 200),
  };
}

function validateTask(value: unknown): TaskSpec {
  if (!value || typeof value !== 'object') throw new Error('task must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.progress !== undefined && (typeof raw.progress !== 'number' || raw.progress < 0 || raw.progress > 1)) {
    throw new Error('task.progress must be between 0 and 1');
  }
  if (raw.actions !== undefined && (!Array.isArray(raw.actions) || raw.actions.length > 4)) {
    throw new Error('task.actions must contain at most 4 actions');
  }
  return {
    title: requiredString(raw.title, 'task.title', 120),
    sub: optionalString(raw.sub, 'task.sub', 220),
    progress: typeof raw.progress === 'number' ? raw.progress : undefined,
    actions: Array.isArray(raw.actions) ? raw.actions.map(validateAction) : undefined,
  };
}

function validateBoard(raw: Record<string, unknown>): BoardSpec {
  const title = requiredString(raw.title, 'board.title', 120);
  if (!Array.isArray(raw.columns)) throw new Error('board.columns must be an array');
  if (raw.columns.length === 0) throw new Error('board.columns must contain at least 1 column');
  if (raw.columns.length > 3) throw new Error('board.columns must contain at most 3 columns');
  const seen = new Set<string>();
  const columns = raw.columns.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('board column must be an object');
    const column = value as Record<string, unknown>;
    if (!isBoardColumnKey(column.key)) {
      throw new Error(`unsupported board column: ${String(column.key)}`);
    }
    const key = column.key;
    if (seen.has(key)) throw new Error(`duplicate board column: ${key}`);
    seen.add(key);
    if (!Array.isArray(column.tasks)) throw new Error('board column tasks must be an array');
    if (column.tasks.length > 12) throw new Error('board column tasks must contain at most 12 tasks');
    return {
      key,
      label: requiredString(column.label, 'board column label', 40),
      tasks: column.tasks.map(validateTask),
    };
  });
  return {
    kind: 'board',
    title,
    columns,
  };
}

function validateChip(raw: Record<string, unknown>): ChipSpec {
  if (raw.icon !== undefined && raw.icon !== 'clock' && raw.icon !== 'check') {
    throw new Error('chip.icon must be clock or check');
  }
  return {
    kind: 'chip',
    icon: raw.icon as 'clock' | 'check' | undefined,
    label: requiredString(raw.label, 'chip.label', 80),
    reply: optionalString(raw.reply, 'chip.reply', 500),
  };
}

export function validateUiSpec(value: unknown): UiSpec {
  if (!value || typeof value !== 'object') throw new Error('spec must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'board') return validateBoard(raw);
  if (raw.kind === 'chip') return validateChip(raw);
  throw new Error('spec.kind must be board or chip');
}

export const renderUi: McpToolDefinition = {
  tool: {
    name: 'render_ui',
    description:
      "Render a small web-native UI in the current conversation. Supports board {kind,title,columns:[{key:'running'|'waiting'|'done',label,tasks:[...]}]} and chip {kind,icon?,label,reply?}. Always include fallbackText for non-web channels.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        spec: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'board' },
                title: { type: 'string', minLength: 1, maxLength: 120 },
                columns: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 3,
                  items: {
                    type: 'object',
                    properties: {
                      key: { enum: ['running', 'waiting', 'done'] },
                      label: { type: 'string', minLength: 1, maxLength: 40 },
                      tasks: {
                        type: 'array',
                        maxItems: 12,
                        items: {
                          type: 'object',
                          properties: {
                            title: { type: 'string', minLength: 1, maxLength: 120 },
                            sub: { type: 'string', minLength: 1, maxLength: 220 },
                            progress: { type: 'number', minimum: 0, maximum: 1 },
                            actions: {
                              type: 'array',
                              maxItems: 4,
                              items: {
                                type: 'object',
                                properties: {
                                  label: { type: 'string', minLength: 1, maxLength: 48 },
                                  style: { enum: ['primary', 'ghost'] },
                                  reply: { type: 'string', minLength: 1, maxLength: 500 },
                                  approvalId: { type: 'string', minLength: 1, maxLength: 200 },
                                },
                                required: ['label'],
                                additionalProperties: false,
                              },
                            },
                          },
                          required: ['title'],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ['key', 'label', 'tasks'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['kind', 'title', 'columns'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                kind: { const: 'chip' },
                icon: { enum: ['clock', 'check'] },
                label: { type: 'string', minLength: 1, maxLength: 80 },
                reply: { type: 'string', minLength: 1, maxLength: 500 },
              },
              required: ['kind', 'label'],
              additionalProperties: false,
            },
          ],
          description:
            "UI spec. Board columns is an array of { key: 'running'|'waiting'|'done', label, tasks }. Duplicate or unsupported keys are rejected. Task progress is 0..1. Action style is primary or ghost. Chip icon is clock or check.",
        },
        fallbackText: {
          type: 'string',
          description: 'Plain text fallback for channels that cannot render UI.',
        },
      },
      required: ['spec', 'fallbackText'],
    },
  },
  async handler(args) {
    let spec: UiSpec;
    try {
      spec = validateUiSpec(args.spec);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    let fallbackText: string;
    try {
      fallbackText = requiredString(args.fallbackText, 'fallbackText', 1000);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }

    const id = generateId();
    const r = getSessionRouting();
    writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'ui', spec, fallbackText }),
    });

    log(`render_ui: ${id} kind=${spec.kind}`);
    return ok(`UI rendered (id: ${id})`);
  },
};

registerTools([renderUi]);
