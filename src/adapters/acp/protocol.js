/**
 * ACP (Agent Client Protocol, agentclientprotocol.com) translation. Gemini
 * CLI, Goose, and OpenCode all expose an ACP agent over stdio, so one client
 * drives all three. Agents stream prose as per-chunk notifications — one
 * broadcast per chunk would flood every feed, so the client coalesces chunks
 * and flushes on turn end or when a tool call interleaves. Thought chunks are
 * private reasoning and never mirrored into a shared room.
 */

import { capture } from '../capture.js';

export const encode = (msg) => JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n';

export const isRequest = (msg) => msg?.id !== undefined && msg?.method !== undefined;
export const isResponse = (msg) => msg?.id !== undefined && msg?.method === undefined;

export const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join('');
  if (content?.type === 'text') return content.text ?? '';
  if (content?.content) return textOf(content.content);
  return '';
};

/**
 * One session/update payload → zero or more normalized events, plus chunk
 * buffering via the caller-owned `buffer` ({ text }). Pure apart from the
 * buffer; exported for tests.
 */
export function translateAcpUpdate(update = {}, buffer = { text: '' }) {
  const events = [];
  const flushProse = () => {
    if (buffer.text.trim()) events.push({ kind: 'agent_message', text: buffer.text });
    buffer.text = '';
  };

  switch (update.sessionUpdate ?? update.type) {
    case 'agent_message_chunk':
      buffer.text += textOf(update.content);
      break;

    case 'agent_thought_chunk':
      break;

    case 'tool_call':
      flushProse();
      events.push({
        kind: 'tool_use',
        tool: update.title ?? update.toolName ?? update.kind ?? 'tool',
        input: compact(update.rawInput ?? update.toolInput),
      });
      break;

    case 'tool_call_update': {
      const status = update.status;
      if (status === 'completed' || status === 'success' || status === 'failed' || status === 'error') {
        events.push({
          kind: 'tool_result',
          tool: update.title ?? update.toolName,
          summary: compact(update.content ?? update.rawOutput ?? '', 200),
          isError: status === 'failed' || status === 'error',
        });
      }
      break;
    }

    default:
      break; // plan, mode updates, config changes — nothing a room feed needs
  }
  return events;
}

/** End-of-turn events for a session/prompt response. Flushes buffered prose. */
export function turnEnd(stopReason, buffer = { text: '' }) {
  const events = [];
  if (buffer.text.trim()) events.push({ kind: 'agent_message', text: buffer.text });
  buffer.text = '';
  const ok = stopReason === 'end_turn' || stopReason === 'endTurn' || stopReason === undefined;
  events.push({ kind: 'result', ok, ...(ok ? {} : { text: `stopped: ${stopReason}` }) });
  events.push({ kind: 'agent_status', status: 'idle' });
  return events;
}

// Stored payloads stay complete (up to the safety cap); renderers truncate.
const compact = (value) => capture(textOf(value) || value);
