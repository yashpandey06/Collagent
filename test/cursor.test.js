import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS, buildHooksConfig, translateCursorHookEvent } from '../src/adapters/cursor/hooks.js';
import { CursorNativeAdapter } from '../src/adapters/cursor/native.js';
import { CursorAgentAdapter, normalizeCursorEvent } from '../src/adapters/cursor/headless.js';
import { describeAdapter, findRuntime, adapterFor } from '../src/adapters/registry.js';

const FAKE_CURSOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cursor-agent.js');

test('cursor hooks: lifecycle payloads translate to normalized events', () => {
  const [ready] = translateCursorHookEvent({
    hook_event_name: 'sessionStart',
    session_id: 'chat-1',
    workspace_roots: ['/work'],
    model: 'gpt-5',
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.detail.sessionId, 'chat-1');
  assert.equal(ready.detail.cwd, '/work');

  const [prompt] = translateCursorHookEvent({ hook_event_name: 'beforeSubmitPrompt', prompt: 'fix tests' });
  assert.equal(prompt.kind, 'local_prompt');

  const [use] = translateCursorHookEvent({
    hook_event_name: 'preToolUse',
    tool_name: 'Shell',
    tool_input: { command: 'npm test' },
  });
  assert.equal(use.kind, 'tool_use');
  assert.match(use.input, /npm test/);

  const [result] = translateCursorHookEvent({
    hook_event_name: 'postToolUse',
    tool_name: 'Shell',
    tool_output: 'all green',
  });
  assert.equal(result.kind, 'tool_result');

  const [prose] = translateCursorHookEvent({ hook_event_name: 'afterAgentResponse', text: 'Done — file created.' });
  assert.equal(prose.kind, 'agent_message');

  assert.deepEqual(
    translateCursorHookEvent({ hook_event_name: 'stop', status: 'completed' }).map((e) => e.kind),
    ['result', 'agent_status'],
  );
  assert.equal(translateCursorHookEvent({ hook_event_name: 'stop', status: 'error' })[0].ok, false);
  assert.equal(translateCursorHookEvent({ hook_event_name: 'sessionEnd', reason: 'user_close' })[0].status, 'exited');
  assert.deepEqual(translateCursorHookEvent({ hook_event_name: 'preCompact' }), []);
});

test('cursor hooks: config merge keeps existing project hooks (flat entry schema)', () => {
  const existing = { version: 1, hooks: { afterFileEdit: [{ command: 'format.sh' }] } };
  const merged = buildHooksConfig(existing, 'node hook.js http://x');
  assert.equal(merged.version, 1);
  assert.deepEqual(merged.hooks.afterFileEdit, [{ command: 'format.sh' }]);
  for (const event of HOOK_EVENTS) {
    const entry = merged.hooks[event].at(-1);
    assert.equal(entry.command, 'node hook.js http://x');
    assert.equal(typeof entry.timeout, 'number');
  }
});

test('cursor native: hooks.json is written into the workspace and restored on disconnect', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-cursor-'));

  // no .cursor dir yet: created, then fully removed
  const a1 = new CursorNativeAdapter({ cwd });
  a1._installHooks('http://127.0.0.1:1/hook/x', cwd);
  const file = path.join(cwd, '.cursor', 'hooks.json');
  assert.ok(fs.existsSync(file));
  await a1.disconnect();
  assert.ok(!fs.existsSync(path.join(cwd, '.cursor')), 'created dir removed');

  // existing project hooks: merged, then restored byte-for-byte
  fs.mkdirSync(path.join(cwd, '.cursor'));
  const original = JSON.stringify({ version: 1, hooks: { stop: [{ command: 'notify.sh' }] } });
  fs.writeFileSync(file, original);
  const a2 = new CursorNativeAdapter({ cwd });
  a2._installHooks('http://127.0.0.1:1/hook/x', cwd);
  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(merged.hooks.stop[0].command, 'notify.sh');
  assert.equal(merged.hooks.stop.length, 2);
  await a2.disconnect();
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('cursor native: injected instructions are not echoed as local prompts', () => {
  const adapter = new CursorNativeAdapter();
  const seen = [];
  adapter.attach((e) => seen.push(e));
  adapter._inject({ text: 'add oauth', from: { name: 'Bob' } });
  adapter._onHook({ hook_event_name: 'beforeSubmitPrompt', prompt: '[Bob] add oauth' });
  assert.equal(seen.filter((e) => e.kind === 'local_prompt').length, 0);
  adapter._onHook({ hook_event_name: 'beforeSubmitPrompt', prompt: 'host typed this' });
  assert.equal(seen.filter((e) => e.kind === 'local_prompt').length, 1);
});

test('cursor stream-json: events normalize like the real wire format', () => {
  const [ready] = normalizeCursorEvent({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: '/w' });
  assert.equal(ready.detail.sessionId, 's1');

  const [msg] = normalizeCursorEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  assert.equal(msg.kind, 'agent_message');

  const [use] = normalizeCursorEvent({
    type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'ls' } } },
  });
  assert.equal(use.tool, 'shell');
  assert.match(use.input, /ls/);

  const [res] = normalizeCursorEvent({
    type: 'tool_call', subtype: 'completed', tool_call: { readToolCall: { args: {}, result: { success: { totalLines: 3 } } } },
  });
  assert.equal(res.kind, 'tool_result');
  assert.equal(res.isError, false);

  const done = normalizeCursorEvent({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 9 });
  assert.deepEqual(done.map((e) => e.kind), ['result', 'agent_status']);
  assert.equal(done[0].ok, true);

  assert.deepEqual(normalizeCursorEvent({ type: 'user', message: {} }), []);
});

test('registry: cursor runtime is available with both adapter shapes', () => {
  const runtime = findRuntime('cursor');
  assert.equal(runtime.status, 'available');
  assert.equal(adapterFor('cursor'), 'cursor-native');
  assert.equal(adapterFor('cursor', { headless: true }), 'cursor');
  assert.equal(describeAdapter('cursor-native').ownsTerminal, true);
  assert.deepEqual(describeAdapter('cursor-native').resumeOptions('c1'), { extraArgs: ['--resume', 'c1'] });
  assert.deepEqual(describeAdapter('cursor').resumeOptions('c1'), { sessionId: 'c1', resume: true });
});

test('cursor headless: full turns against the fake CLI, resuming one session', async () => {
  const adapter = new CursorAgentAdapter({ cursorPath: FAKE_CURSOR, cwd: os.tmpdir() });
  const events = [];
  adapter.attach((e) => events.push(e));
  await adapter.createSession();

  const turn = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no result')), 5000);
    const off = adapter.attach((e) => {
      if (e.kind === 'result') { clearTimeout(t); off(); resolve(); }
    });
  });

  const done1 = turn();
  await adapter.sendInstruction({ text: 'first task', from: { name: 'Bob' } });
  await done1;

  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('tool_use') && kinds.includes('tool_result'));
  const echo = events.find((e) => e.kind === 'agent_message');
  assert.match(echo.text, /\[Bob\] first task/);
  assert.ok(adapter.sessionId, 'session id captured from init');
  const firstSession = adapter.sessionId;

  const done2 = turn();
  await adapter.sendInstruction({ text: 'second task', from: { name: 'Alice' } });
  await done2;
  assert.equal(adapter.sessionId, firstSession, 'same conversation resumed');
  assert.match(events.filter((e) => e.kind === 'agent_message').at(-1).text, /resumed/);

  await adapter.disconnect();
});

test('cursor headless: paused instructions queue and flush on resume', async () => {
  const adapter = new CursorAgentAdapter({ cursorPath: FAKE_CURSOR, cwd: os.tmpdir() });
  await adapter.createSession();
  await adapter.pause();
  const { queued } = await adapter.sendInstruction({ text: 'later', from: { name: 'Bob' } });
  assert.equal(queued, true);

  const done = new Promise((resolve) => {
    adapter.attach((e) => e.kind === 'result' && resolve());
  });
  await adapter.resume();
  await done;
  await adapter.disconnect();
});
