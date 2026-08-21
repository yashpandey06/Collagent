import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterTypes } from '../src/adapters/registry.js';
import { extractTranscriptUpdates } from '../src/adapters/claude/native.js';
import { normalizeClaudeMessage } from '../src/adapters/claude/headless.js';
import { translateCodexHookEvent } from '../src/adapters/codex/hooks.js';
import { translateAppServerEvent } from '../src/adapters/codex/protocol.js';
import { extractBlobEvents } from '../src/adapters/cursor/store.js';
import { normalizeCursorEvent } from '../src/adapters/cursor/headless.js';
import { translateGeminiHookEvent } from '../src/adapters/gemini/hooks.js';
import { translateGooseHookEvent } from '../src/adapters/goose/hooks.js';
import { translateOpencodeEvent, newTranslationState } from '../src/adapters/opencode/native.js';
import { translateAcpUpdate, turnEnd } from '../src/adapters/acp/protocol.js';
import { MockAdapter } from '../src/adapters/mock.js';

/**
 * The transparency guarantee: every registered adapter mirrors the agent's
 * replies into the room as agent_message events, so all participants see what
 * the agent said — not just its tool activity. Registering a runtime without
 * a prose path fails this test.
 */

const REPLY = 'Refactored the login flow — tests pass.';

const prose = (events) => events.filter((e) => e.kind === 'agent_message').map((e) => e.text);

// The three ACP-driven runtimes share one client, and so one prose path.
const acpReply = () => {
  const buffer = { text: '' };
  translateAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } }, buffer);
  return prose(turnEnd('end_turn', buffer));
};

// adapter id → the runtime's own wire shape carrying a reply → mirrored texts
const REPLY_PATHS = {
  'claude-native': () =>
    extractTranscriptUpdates(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: REPLY }] },
    })).texts,

  'claude-code': () =>
    prose(normalizeClaudeMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: REPLY }] },
    })),

  'codex-native': () =>
    prose(translateCodexHookEvent({ hook_event_name: 'Stop', last_assistant_message: REPLY })),

  codex: () =>
    prose(translateAppServerEvent({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', text: REPLY } },
    })),

  'cursor-native': () =>
    prose(extractBlobEvents({ role: 'assistant', content: [{ type: 'text', text: REPLY }] })),

  cursor: () =>
    prose(normalizeCursorEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: REPLY }] },
    })),

  'gemini-native': () =>
    prose(translateGeminiHookEvent({ hook_event_name: 'AfterAgent', prompt_response: REPLY })),

  gemini: acpReply,

  'goose-native': () =>
    prose(translateGooseHookEvent({ event: 'Stop', last_assistant_message: REPLY })),

  goose: acpReply,

  'opencode-native': () => {
    const state = newTranslationState();
    translateOpencodeEvent({ type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } }, state);
    translateOpencodeEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p1', messageID: 'm1', type: 'text', text: REPLY } },
    }, state);
    return prose(translateOpencodeEvent({ type: 'session.idle', properties: {} }, state));
  },

  opencode: acpReply,

  mock: async () => {
    const adapter = new MockAdapter({ delay: 1 });
    const texts = [];
    adapter.attach((e) => e.kind === 'agent_message' && texts.push(e.text));
    await adapter.createSession();
    await adapter.sendInstruction({ text: REPLY, from: { name: 'Bob' } });
    return texts;
  },
};

test('every registered adapter mirrors agent replies into the room feed', async () => {
  for (const type of adapterTypes()) {
    const path = REPLY_PATHS[type];
    assert.ok(path, `adapter "${type}" has no reply-parity fixture — every runtime must mirror agent replies`);
    const texts = await path();
    assert.ok(
      texts.some((t) => t.includes(REPLY)),
      `adapter "${type}" did not surface the agent's reply as agent_message`,
    );
  }
});
