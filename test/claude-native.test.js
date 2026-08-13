import test from 'node:test';
import assert from 'node:assert/strict';
import { translateHookEvent, ClaudeNativeAdapter } from '../src/adapters/claude-native.js';

test('hooks: SessionStart → ready with session detail', () => {
  const events = translateHookEvent({
    hook_event_name: 'SessionStart',
    session_id: 'abc',
    cwd: '/work',
    source: 'startup',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'agent_status');
  assert.equal(events[0].status, 'ready');
  assert.equal(events[0].detail.sessionId, 'abc');
});

test('hooks: UserPromptSubmit → local_prompt (host typed in native UI)', () => {
  const [e] = translateHookEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the tests' });
  assert.equal(e.kind, 'local_prompt');
  assert.equal(e.text, 'fix the tests');
});

test('hooks: Pre/PostToolUse → tool_use / tool_result', () => {
  const [use] = translateHookEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  assert.equal(use.kind, 'tool_use');
  assert.equal(use.tool, 'Bash');
  assert.match(use.input, /npm test/);

  const [result] = translateHookEvent({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: { stdout: 'all tests passed\n\n', stderr: '' },
  });
  assert.equal(result.kind, 'tool_result');
  assert.match(result.summary, /all tests passed/);
});

test('hooks: Stop → result + idle; Notification → notice; SessionEnd → exited', () => {
  const stop = translateHookEvent({ hook_event_name: 'Stop' });
  assert.deepEqual(stop.map((e) => e.kind), ['result', 'agent_status']);
  assert.equal(stop[0].ok, true);
  assert.equal(stop[1].status, 'idle');

  const [notice] = translateHookEvent({
    hook_event_name: 'Notification',
    message: 'Claude needs permission to run Bash',
  });
  assert.equal(notice.kind, 'notice');
  assert.match(notice.message, /permission/);

  const [end] = translateHookEvent({ hook_event_name: 'SessionEnd', reason: 'exit' });
  assert.equal(end.kind, 'agent_status');
  assert.equal(end.status, 'exited');
});

test('hooks: unknown events are ignored', () => {
  assert.deepEqual(translateHookEvent({ hook_event_name: 'PreCompact' }), []);
  assert.deepEqual(translateHookEvent({}), []);
});

test('injected remote instructions are not echoed back as local prompts', () => {
  const adapter = new ClaudeNativeAdapter();
  const seen = [];
  adapter.attach((e) => seen.push(e));

  // Simulate a remote injection into the composer (no real PTY needed:
  // _inject records the text before writing, and pty is null-guarded).
  adapter._inject({ text: 'add oauth validation', from: { name: 'Bob' } });

  // The composer submit fires UserPromptSubmit with the injected text …
  adapter._onHook({ hook_event_name: 'UserPromptSubmit', prompt: '[Bob] add oauth validation' });
  assert.equal(seen.filter((e) => e.kind === 'local_prompt').length, 0, 'injection must not echo');

  // … while a prompt the host actually typed still comes through.
  adapter._onHook({ hook_event_name: 'UserPromptSubmit', prompt: 'something alice typed' });
  assert.equal(seen.filter((e) => e.kind === 'local_prompt').length, 1);
});

test('paused native adapter queues instructions until resume', async () => {
  const adapter = new ClaudeNativeAdapter();
  adapter.sessionStarted = true; // as if SessionStart hook already fired
  await adapter.pause();
  const { queued } = await adapter.sendInstruction({ text: 'later', from: { name: 'Bob' } });
  assert.equal(queued, true);
  assert.equal(adapter.queue.length, 1);
  await adapter.resume();
  assert.equal(adapter.queue.length, 0);
});

test('settings overlay registers hooks and the session status line', async () => {
  const fs = await import('node:fs');
  const adapter = new ClaudeNativeAdapter({
    statusUrl: 'http://127.0.0.1:7717/api/sessions/7FK2P',
    sessionCode: '7FK2P',
  });
  const file = adapter._writeHookSettings('http://127.0.0.1:9999/hook/x');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.unlinkSync(file);

  for (const hook of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd']) {
    assert.ok(settings.hooks[hook], `${hook} hook registered`);
  }
  assert.equal(settings.statusLine.type, 'command');
  assert.match(settings.statusLine.command, /collagent-statusline\.js/);
  assert.match(settings.statusLine.command, /7FK2P/);
  assert.ok(settings.statusLine.refreshInterval >= 1, 'presence must refresh without conversation activity');

  // without statusline options, no statusLine key is injected
  const bare = new ClaudeNativeAdapter();
  const file2 = bare._writeHookSettings('http://127.0.0.1:9999/hook/x');
  const settings2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
  fs.unlinkSync(file2);
  assert.equal(settings2.statusLine, undefined);
});

test('instructions queue until the interactive session has started', async () => {
  const adapter = new ClaudeNativeAdapter();
  const { queued } = await adapter.sendInstruction({ text: 'early', from: { name: 'Bob' } });
  assert.equal(queued, true, 'held while startup screens (trust dialog etc.) may be up');

  // SessionStart hook flushes the queue (after a short settle delay)
  adapter._onHook({ hook_event_name: 'SessionStart', session_id: 's1' });
  assert.equal(adapter.sessionStarted, true);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(adapter.queue.length, 0);
  // and the queued text is registered as an injection (for echo dedupe)
  assert.ok(adapter._recentInjections.some((e) => e.text === '[Bob] early'));
});
