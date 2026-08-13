#!/usr/bin/env node
/**
 * Emulates `claude -p --input-format stream-json --output-format stream-json`
 * closely enough to integration-test the ClaudeCodeAdapter without needing a
 * real Claude Code login. Accepts (and ignores) the same CLI flags.
 */
import { createInterface } from 'node:readline';

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

out({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-session-1',
  model: 'fake-model-1',
  cwd: process.cwd(),
  tools: ['Bash', 'Write'],
});

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type !== 'user') return;
  const text = (msg.message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');

  out({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: `Working on: ${text}` },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo ok' } },
      ],
    },
  });
  out({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: false }],
    },
  });
  out({
    type: 'result',
    subtype: 'success',
    result: `Done: ${text}`,
    duration_ms: 12,
    total_cost_usd: 0.0012,
    num_turns: 1,
  });
});

rl.on('close', () => process.exit(0));
