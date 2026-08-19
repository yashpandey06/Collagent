import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { translateAcpUpdate, turnEnd } from '../src/adapters/acp/protocol.js';
import { AcpAdapter } from '../src/adapters/acp/client.js';

const FAKE_ACP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.js');

test('acp: message chunks coalesce and flush before tool calls / at turn end', () => {
  const buffer = { text: '' };
  assert.deepEqual(translateAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me ' } }, buffer), []);
  assert.deepEqual(translateAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'check.' } }, buffer), []);
  assert.deepEqual(translateAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }, buffer), []);

  const atTool = translateAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', rawInput: { path: 'a.js' } }, buffer);
  assert.deepEqual(atTool.map((e) => e.kind), ['agent_message', 'tool_use'], 'prose flushes ahead of the tool call');
  assert.equal(atTool[0].text, 'Let me check.');
  assert.match(atTool[1].input, /a\.js/);

  assert.deepEqual(translateAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'running' }, buffer), []);
  const [result] = translateAcpUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'read', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  }, buffer);
  assert.equal(result.kind, 'tool_result');
  assert.equal(result.isError, false);

  buffer.text = 'Done.';
  const end = turnEnd('end_turn', buffer);
  assert.deepEqual(end.map((e) => e.kind), ['agent_message', 'result', 'agent_status']);
  assert.equal(end[1].ok, true);
  assert.equal(turnEnd('cancelled')[0].ok, false);
});

test('acp: full turn against the fake agent, permissions auto-approved', async () => {
  const adapter = new AcpAdapter({ command: process.execPath, args: [FAKE_ACP], cwd: os.tmpdir(), label: 'fake' });
  const events = [];
  adapter.attach((e) => events.push(e));
  await adapter.createSession();
  assert.equal(adapter.sessionId, 'acp-123');

  await adapter.sendInstruction({ text: 'list files', from: { name: 'Bob' } });

  const kinds = events.map((e) => e.kind + (e.status ? ':' + e.status : ''));
  assert.deepEqual(kinds, [
    'agent_status:starting', 'agent_status:ready', 'agent_status:working',
    'agent_message', 'tool_use', 'notice', 'tool_result', 'agent_message',
    'result', 'agent_status:idle',
  ]);
  assert.match(events.find((e) => e.kind === 'agent_message').text, /\[Bob\] list files/);
  assert.equal(events.find((e) => e.kind === 'tool_result').isError, false, 'approval selected the allow option');
  assert.equal(events.find((e) => e.kind === 'result').ok, true);

  await adapter.disconnect();
});

test('acp: autoApprove off declines permission requests', async () => {
  const adapter = new AcpAdapter({
    command: process.execPath, args: [FAKE_ACP], cwd: os.tmpdir(), autoApprove: false,
  });
  const events = [];
  adapter.attach((e) => events.push(e));
  await adapter.createSession();
  await adapter.sendInstruction({ text: 'try something', from: { name: 'Bob' } });
  assert.equal(events.find((e) => e.kind === 'tool_result').isError, true, 'declined tool fails');
  assert.match(events.find((e) => e.kind === 'notice').message, /declined/);
  await adapter.disconnect();
});

test('acp: resume loads the stored session instead of starting fresh', async () => {
  const adapter = new AcpAdapter({
    command: process.execPath, args: [FAKE_ACP], cwd: os.tmpdir(),
    sessionId: 'acp-old', resume: true,
  });
  const events = [];
  adapter.attach((e) => events.push(e));
  await adapter.createSession();
  assert.equal(adapter.sessionId, 'acp-old', 'session id preserved through session/load');

  await adapter.sendInstruction({ text: 'continue', from: { name: 'Bob' } });
  assert.match(events.find((e) => e.kind === 'agent_message').text, /resumed/, 'fixture saw session/load');
  await adapter.disconnect();
});

test('acp: paused instructions queue and flush on resume', async () => {
  const adapter = new AcpAdapter({ command: process.execPath, args: [FAKE_ACP], cwd: os.tmpdir() });
  const events = [];
  adapter.attach((e) => events.push(e));
  await adapter.createSession();
  await adapter.pause();
  const { queued } = await adapter.sendInstruction({ text: 'later', from: { name: 'Bob' } });
  assert.equal(queued, true);
  await adapter.resume();
  assert.ok(events.some((e) => e.kind === 'result' && e.ok), 'queued instruction ran');
  await adapter.disconnect();
});
