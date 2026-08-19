import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translateHookEvent, extractTranscriptUpdates, ClaudeNativeAdapter } from '../src/adapters/claude/native.js';

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

test('transcript parsing keeps assistant prose + title, drops tools/thinking/sidechains', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', name: 'Read', input: {} }] } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix OAuth validation' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'All done.' }] } }),
    'not json at all',
  ].join('\n');
  const { texts, title } = extractTranscriptUpdates(jsonl);
  assert.deepEqual(texts, ['Let me check.', 'All done.']);
  assert.equal(title, 'Fix OAuth validation');
});

test('hooks mirror new transcript prose as agent_message, skipping replayed history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collagent-transcript-'));
  const transcript = path.join(dir, 'session.jsonl');
  const assistantLine = (text) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';

  // A resumed conversation already has history on disk before SessionStart.
  fs.writeFileSync(transcript, assistantLine('old reply from a previous run'));

  const adapter = new ClaudeNativeAdapter();
  const seen = [];
  adapter.attach((e) => seen.push(e));

  adapter._onHook({ hook_event_name: 'SessionStart', session_id: 's1', transcript_path: transcript });
  assert.equal(seen.filter((e) => e.kind === 'agent_message').length, 0, 'history is never re-broadcast');

  // Turn 1: the Stop hook fires FIRST, and the prose lands in the transcript
  // shortly after — the write order Claude Code actually exhibits. The
  // deferred flush must still catch it and keep prose ahead of the result.
  adapter._onHook({ hook_event_name: 'Stop', transcript_path: transcript });
  fs.appendFileSync(transcript, assistantLine('Hey! What are we working on today?'));
  await new Promise((r) => setTimeout(r, 900));
  let messages = seen.filter((e) => e.kind === 'agent_message');
  assert.deepEqual(messages.map((e) => e.text), ['Hey! What are we working on today?']);
  assert.ok(
    seen.findIndex((e) => e.kind === 'agent_message') < seen.findIndex((e) => e.kind === 'result'),
    'prose arrives before the turn result',
  );

  // Turn 2: only new prose is emitted (PreToolUse flushes too, so commentary
  // precedes its tool call), and the session title surfaces once.
  fs.appendFileSync(transcript, assistantLine('Let me look at the tests.'));
  fs.appendFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Investigate failing tests' }) + '\n');
  adapter._onHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, transcript_path: transcript });
  messages = seen.filter((e) => e.kind === 'agent_message');
  assert.deepEqual(messages.at(-1).text, 'Let me look at the tests.');
  assert.equal(messages.length, 2, 'nothing double-emitted');
  const titles = seen.filter((e) => e.kind === 'session_title');
  assert.deepEqual(titles.map((e) => e.title), ['Investigate failing tests']);

  fs.rmSync(dir, { recursive: true, force: true });
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
