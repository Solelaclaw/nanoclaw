import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { renderUi, validateUiSpec } from './render-ui.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('render_ui MCP tool', () => {
  it('writes constrained UI payloads to outbound chat-sdk content', async () => {
    const result = await renderUi.handler({
      spec: {
        kind: 'board',
        title: 'Plate',
        columns: [
          { key: 'running', label: 'Running', tasks: [{ title: 'Live run', progress: 0.5 }] },
          {
            key: 'waiting',
            label: 'Waiting',
            tasks: [{ title: 'Approval', actions: [{ label: 'Approve', style: 'primary', approvalId: 'ap-1' }] }],
          },
          { key: 'done', label: 'Done today', tasks: [{ title: 'Finished' }] },
        ],
      },
      fallbackText: 'Plate: running 1, waiting 1, done 1',
    });

    expect(result.isError).toBeUndefined();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat-sdk');
    expect(JSON.parse(out[0].content)).toEqual({
      type: 'ui',
      spec: {
        kind: 'board',
        title: 'Plate',
        columns: [
          { key: 'running', label: 'Running', tasks: [{ title: 'Live run', progress: 0.5 }] },
          {
            key: 'waiting',
            label: 'Waiting',
            tasks: [{ title: 'Approval', actions: [{ label: 'Approve', style: 'primary', approvalId: 'ap-1' }] }],
          },
          { key: 'done', label: 'Done today', tasks: [{ title: 'Finished' }] },
        ],
      },
      fallbackText: 'Plate: running 1, waiting 1, done 1',
    });
  });

  it('rejects unsupported vocabulary at runtime', () => {
    expect(() =>
      validateUiSpec({
        kind: 'board',
        title: 'Bad',
        columns: [{ key: 'running', label: 'Running', tasks: [{ title: 'x', progress: 2 }] }],
      }),
    ).toThrow('task.progress must be between 0 and 1');

    expect(() =>
      validateUiSpec({
        kind: 'board',
        title: 'Bad',
        columns: [{ key: 'blocked', label: 'Blocked', tasks: [] }],
      }),
    ).toThrow('unsupported board column: blocked');

    expect(() =>
      validateUiSpec({
        kind: 'board',
        title: 'Bad',
        columns: [
          { key: 'running', label: 'Running', tasks: [] },
          { key: 'running', label: 'Also running', tasks: [] },
        ],
      }),
    ).toThrow('duplicate board column: running');

    expect(() => validateUiSpec({ kind: 'chip', icon: 'alert', label: 'Queued' })).toThrow(
      'chip.icon must be clock or check',
    );
  });
});
