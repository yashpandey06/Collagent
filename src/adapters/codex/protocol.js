/**
 * Codex app-server protocol: framing plus translation into Collagent's
 * normalized events.
 *
 * The app server speaks JSON-RPC 2.0 over stdio as newline-delimited JSON,
 * with two deviations that matter:
 *
 *   1. It never emits the `jsonrpc` field. A strict JSON-RPC client that
 *      validates inbound frames rejects every message, so we parse leniently.
 *   2. Notifications carry an extra top-level `emittedAtMs`.
 *
 * Item lifecycle is `item/started` → optional deltas → `item/completed`.
 * We deliberately ignore the delta notifications: one broadcast event per
 * streamed token would flood every participant's feed, and `item/completed`
 * carries the whole item. Reasoning items are dropped too — they are the
 * model's private thinking, not something to mirror into a shared room.
 */

/** Frame one outbound message. */
export const encode = (msg) => JSON.stringify(msg) + '\n';

/** A server→client *request* expects a reply; a notification does not. */
export const isServerRequest = (msg) => msg?.id !== undefined && msg?.method !== undefined;

/** A reply to one of our requests. */
export const isResponse = (msg) => msg?.id !== undefined && msg?.method === undefined;

/**
 * Translate one app-server notification into zero or more normalized events.
 * Pure function — exported for tests.
 */
export function translateAppServerEvent(msg = {}) {
  const p = msg.params ?? {};

  switch (msg.method) {
    case 'turn/started':
      return [{ kind: 'agent_status', status: 'working' }];

    case 'turn/completed': {
      const status = p.turn?.status ?? 'completed';
      return [
        { kind: 'result', ok: status === 'completed', text: undefined },
        { kind: 'agent_status', status: 'idle' },
      ];
    }

    case 'turn/failed':
      return [
        { kind: 'error', message: p.error?.message ?? 'turn failed' },
        { kind: 'result', ok: false },
        { kind: 'agent_status', status: 'idle' },
      ];

    case 'item/started':
      return startedItem(p.item ?? {});

    case 'item/completed':
      return completedItem(p.item ?? {});

    default:
      return [];
  }
}

/** Tool-shaped items announce themselves when they begin. */
function startedItem(item) {
  switch (item.type) {
    case 'commandExecution':
      return [{ kind: 'tool_use', tool: 'shell', input: compact(item.command) }];
    case 'fileChange':
      return [{ kind: 'tool_use', tool: 'edit', input: compact(changedPaths(item)) }];
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return [{ kind: 'tool_use', tool: item.name ?? item.tool ?? 'tool', input: compact(item.arguments ?? item.input) }];
    case 'webSearch':
      return [{ kind: 'tool_use', tool: 'web_search', input: compact(item.query) }];
    default:
      return []; // agentMessage/reasoning/plan/… have nothing useful to say yet
  }
}

function completedItem(item) {
  switch (item.type) {
    case 'agentMessage': {
      const text = item.text ?? item.message ?? '';
      return text.trim() ? [{ kind: 'agent_message', text }] : [];
    }
    case 'commandExecution':
      return [{
        kind: 'tool_result',
        tool: 'shell',
        summary: compact(item.aggregatedOutput ?? '', 200),
        isError: failed(item),
      }];
    case 'fileChange':
      return [{
        kind: 'tool_result',
        tool: 'edit',
        summary: compact(changedPaths(item), 200),
        isError: failed(item),
      }];
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return [{
        kind: 'tool_result',
        tool: item.name ?? item.tool ?? 'tool',
        summary: compact(item.result ?? item.output ?? '', 200),
        isError: failed(item),
      }];
    case 'webSearch':
      return [{ kind: 'tool_result', tool: 'web_search', summary: compact(item.query ?? '', 200) }];
    case 'error':
      return [{ kind: 'error', message: compact(item.message ?? 'codex error', 200) }];
    default:
      return []; // reasoning, plan, userMessage, contextCompaction, …
  }
}

const failed = (item) =>
  item.status === 'failed' || item.status === 'declined' ||
  (item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0);

const changedPaths = (item) =>
  Array.isArray(item.changes) ? item.changes.map((c) => c.path).filter(Boolean).join(', ') : '';

function compact(value, max = 400) {
  let s;
  if (typeof value === 'string') s = value;
  else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
