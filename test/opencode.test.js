import test from 'node:test';
import assert from 'node:assert/strict';
import { translateOpencodeEvent, newTranslationState } from '../src/adapters/opencode/native.js';
import { AcpAdapter } from '../src/adapters/acp/client.js';
import { describeAdapter, findRuntime, adapterFor } from '../src/adapters/registry.js';

// Event shapes below are real captures from opencode 1.18.18's /event stream.
test('opencode: SSE bus events translate into one coherent turn', () => {
  const state = newTranslationState();
  const feed = [];
  const push = (evt) => feed.push(...translateOpencodeEvent(evt, state));

  push({ type: 'session.created', properties: { sessionID: 'ses_1', info: { id: 'ses_1', directory: '/work' } } });
  push({ type: 'session.updated', properties: { info: { id: 'ses_1', title: 'Fix the login flow' } } });
  push({ type: 'message.updated', properties: { info: { id: 'msg_u', role: 'user' } } });
  push({ type: 'message.part.updated', properties: { part: { id: 'prt_u', messageID: 'msg_u', type: 'text', text: 'fix login' } } });
  push({ type: 'message.part.updated', properties: { part: { id: 'prt_u', messageID: 'msg_u', type: 'text', text: 'fix login' } } });
  push({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
  push({ type: 'message.updated', properties: { info: { id: 'msg_a', role: 'assistant' } } });
  push({ type: 'message.part.updated', properties: { part: { id: 'prt_1', messageID: 'msg_a', type: 'text', text: 'Looking' } } });
  push({ type: 'message.part.updated', properties: { part: { id: 'prt_1', messageID: 'msg_a', type: 'text', text: 'Looking at auth.ts' } } });
  push({
    type: 'message.part.updated',
    properties: { part: { id: 'prt_t', messageID: 'msg_a', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'npm test' } } } },
  });
  push({
    type: 'message.part.updated',
    properties: { part: { id: 'prt_t', messageID: 'msg_a', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'all green' } } },
  });
  push({ type: 'session.idle', properties: { sessionID: 'ses_1' } });

  const kinds = feed.map((e) => e.kind + (e.status ? ':' + e.status : ''));
  assert.deepEqual(kinds, [
    'agent_status:ready', 'session_title', 'local_prompt', 'agent_status:working',
    'tool_use', 'tool_result', 'agent_message', 'result', 'agent_status:idle',
  ]);
  assert.equal(feed.find((e) => e.kind === 'session_title').title, 'Fix the login flow');
  assert.equal(feed.filter((e) => e.kind === 'local_prompt').length, 1, 'user part emitted once');
  assert.equal(feed.find((e) => e.kind === 'agent_message').text, 'Looking at auth.ts', 'part updates replace, not append');
  assert.match(feed.find((e) => e.kind === 'tool_use').input, /npm test/);
  assert.equal(state.sessionId, 'ses_1');
});

test('opencode: errors and permission prompts surface', () => {
  const state = newTranslationState();
  const [err] = translateOpencodeEvent({ type: 'session.error', properties: { error: { name: 'X', data: { message: 'boom' } } } }, state);
  assert.equal(err.kind, 'error');
  const [notice] = translateOpencodeEvent({ type: 'permission.asked', properties: { sessionID: 's' } }, state);
  assert.equal(notice.kind, 'notice');
  assert.deepEqual(translateOpencodeEvent({ type: 'server.heartbeat' }, state), []);
});

test('registry: opencode runtime resolves to native + ACP adapters', () => {
  assert.equal(findRuntime('opencode').status, 'available');
  assert.equal(adapterFor('opencode'), 'opencode-native');
  assert.equal(adapterFor('opencode', { headless: true }), 'opencode');
  assert.equal(describeAdapter('opencode-native').ownsTerminal, true);
  assert.deepEqual(describeAdapter('opencode-native').resumeOptions('ses_1'), { sessionId: 'ses_1', resume: true });
  const headless = describeAdapter('opencode').create({});
  assert.ok(headless instanceof AcpAdapter);
  assert.deepEqual(headless.options.args, ['acp']);
});
