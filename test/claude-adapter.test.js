import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAdapter, normalizeClaudeMessage } from '../src/adapters/claude-code.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(__dirname, 'fixtures', 'fake-claude.js');

test('normalize: system init → ready status with agent info', () => {
  const events = normalizeClaudeMessage({
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'claude-x',
    cwd: '/tmp',
    tools: ['Bash'],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'agent_status');
  assert.equal(events[0].status, 'ready');
  assert.equal(events[0].detail.model, 'claude-x');
  assert.equal(events[0].detail.sessionId, 's1');
});

test('normalize: assistant message → agent_message + tool_use events', () => {
  const events = normalizeClaudeMessage({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', name: 'Write', input: { file_path: 'a.txt', content: 'hi' } },
      ],
    },
  });
  assert.deepEqual(events.map((e) => e.kind), ['agent_message', 'tool_use']);
  assert.equal(events[1].tool, 'Write');
  assert.match(events[1].input, /a\.txt/);
});

test('normalize: tool_result and turn result', () => {
  const [toolResult] = normalizeClaudeMessage({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'wrote file', is_error: false }] },
  });
  assert.equal(toolResult.kind, 'tool_result');
  assert.equal(toolResult.summary, 'wrote file');

  const events = normalizeClaudeMessage({
    type: 'result',
    subtype: 'success',
    result: 'All done',
    duration_ms: 4200,
    total_cost_usd: 0.05,
    num_turns: 3,
  });
  assert.deepEqual(events.map((e) => e.kind), ['result', 'agent_status']);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].text, 'All done');
  assert.equal(events[1].status, 'idle');
});

test('normalize: unknown / partial messages produce no events', () => {
  assert.deepEqual(normalizeClaudeMessage({ type: 'system', subtype: 'other' }), []);
  assert.deepEqual(normalizeClaudeMessage({ type: 'stream_event' }), []);
});

test('adapter drives a stream-json process end to end (fake claude)', async () => {
  fs.chmodSync(FAKE_CLAUDE, 0o755);
  const adapter = new ClaudeCodeAdapter({ claudePath: FAKE_CLAUDE, cwd: __dirname });
  const events = [];
  adapter.attach((e) => events.push(e));

  const waitFor = (pred, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const found = events.find(pred);
        if (found) {
          clearInterval(timer);
          resolve(found);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timed out; saw: ${events.map((e) => e.kind).join(',')}`));
        }
      }, 10);
    });

  await adapter.createSession();
  // First "ready" fires on process spawn (lazy init); the detailed one
  // arrives once the runtime reports its init message.
  const ready = await waitFor((e) => e.kind === 'agent_status' && e.status === 'ready' && e.detail?.model);
  assert.equal(ready.detail.model, 'fake-model-1');

  await adapter.sendInstruction({ text: 'build the thing', from: { name: 'Bob' } });
  const message = await waitFor((e) => e.kind === 'agent_message');
  // Instructions are tagged with the sender so the shared agent knows who spoke
  assert.match(message.text, /\[Bob\] build the thing/);
  await waitFor((e) => e.kind === 'tool_use' && e.tool === 'Bash');
  await waitFor((e) => e.kind === 'tool_result');
  const result = await waitFor((e) => e.kind === 'result');
  assert.equal(result.ok, true);

  // pause queues instructions instead of sending them
  await adapter.pause();
  const { queued } = await adapter.sendInstruction({ text: 'held', from: { name: 'Alice' } });
  assert.equal(queued, true);
  const before = events.filter((e) => e.kind === 'result').length;

  await adapter.resume();
  await waitFor((e) => e.kind === 'result' && events.filter((x) => x.kind === 'result').length > before);
  const held = events.filter((e) => e.kind === 'agent_message').map((e) => e.text);
  assert.ok(held.some((t) => t.includes('[Alice] held')));

  await adapter.disconnect();
});
