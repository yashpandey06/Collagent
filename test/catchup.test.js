import test from 'node:test';
import assert from 'node:assert/strict';
import { catchupSummary, currentActivity } from '../src/core/catchup.js';
import { routeInput } from '../src/ui/tui.js';

test('catch-up digest folds missed events into a handful of lines', () => {
  const events = [
    { kind: 'participant_joined', actor: { name: 'Bob' } },
    { kind: 'instruction', actor: { name: 'Bob' }, data: { text: 'investigate the payment failure' } },
    { kind: 'tool_use', agentId: 'claude-1', data: { tool: 'Bash' } },
    { kind: 'tool_use', agentId: 'claude-1', data: { tool: 'Edit' } },
    { kind: 'result', agentId: 'claude-1', data: { ok: true } },
    { kind: 'agent_session_attached', agentId: 'codex-1' },
    { kind: 'tool_use', agentId: 'codex-1', data: { tool: 'shell' } },
    { kind: 'result', agentId: 'codex-1', data: { ok: true } },
    { kind: 'handoff_completed', actor: { name: 'Alice' }, data: { to: { name: 'Bob' } } },
    { kind: 'participant_left', actor: { name: 'Sarah' } },
  ];
  const lines = catchupSummary(events, { selfName: 'Alice' });
  assert.ok(lines.length <= 8, 'a digest, not a replay');
  assert.ok(lines.some((l) => /Bob joined/.test(l)));
  assert.ok(lines.some((l) => /Sarah left/.test(l)));
  assert.ok(lines.some((l) => /investigate the payment failure/.test(l)));
  assert.ok(lines.some((l) => /claude-1 .*1 turn/.test(l)));
  assert.ok(lines.some((l) => /codex-1 joined the room/.test(l)));
  assert.ok(lines.some((l) => /handoff: Alice → Bob/.test(l)));
});

test('current activity names the agents working right now', () => {
  const session = {
    agents: [
      { agentId: 'claude-1', attached: true, status: 'working' },
      { agentId: 'codex-1', attached: true, status: 'idle' },
      { agentId: 'cursor-1', attached: false, status: 'working' },
    ],
  };
  assert.equal(currentActivity(session), '● claude-1 is currently working');
  assert.equal(currentActivity({ agents: [] }), null);
});

test('@ addressing routes through the participant input', () => {
  assert.deepEqual(routeInput('@codex-1 inspect the frontend'), {
    type: 'instruction',
    to: 'codex-1',
    text: 'inspect the frontend',
  });
  assert.deepEqual(routeInput('@claude'), { type: 'room', cmd: 'use', rest: ['claude'] });
  assert.deepEqual(routeInput('/use codex-1'), { type: 'room', cmd: 'use', rest: ['codex-1'] });
  assert.deepEqual(routeInput('/agents'), { type: 'room', cmd: 'agents', rest: [] });
  assert.deepEqual(routeInput('/add codex'), { type: 'room', cmd: 'add', rest: ['codex'] });
  // plain text and agent slash commands still flow untouched
  assert.deepEqual(routeInput('fix the tests'), { type: 'instruction', text: 'fix the tests' });
  assert.deepEqual(routeInput('/model'), { type: 'instruction', text: '/model' });
});
