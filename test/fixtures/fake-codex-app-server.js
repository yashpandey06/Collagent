#!/usr/bin/env node
/**
 * Emulates `codex app-server` closely enough to integration-test the
 * CodexAppServerAdapter without a real Codex install or login.
 *
 * Reproduces the two deviations from plain JSON-RPC that the adapter has to
 * cope with: responses omit the `jsonrpc` field, and notifications carry an
 * extra top-level `emittedAtMs`.
 */
import { createInterface } from 'node:readline';

const THREAD_ID = '01a01574-e9e0-7143-a003-8b70d68f8890';

const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ method, params, emittedAtMs: Date.now() }) + '\n');

let initialized = false;
let turns = 0;

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'initialized') {
    initialized = true;
    return;
  }
  if (msg.id === undefined) return; // any other notification

  if (msg.method !== 'initialize' && !initialized) {
    return process.stdout.write(
      JSON.stringify({ id: msg.id, error: { code: -32002, message: 'Not initialized' } }) + '\n',
    );
  }

  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { userAgent: 'fake-codex/0.0.0', platformOs: 'macos' });

    case 'thread/start':
    case 'thread/resume': {
      const thread = {
        id: msg.params?.threadId ?? THREAD_ID,
        sessionId: msg.params?.threadId ?? THREAD_ID,
        cwd: msg.params?.cwd ?? process.cwd(),
        status: { type: 'idle' },
      };
      reply(msg.id, { thread, model: 'fake-codex-model', cwd: thread.cwd });
      return notify('thread/started', { thread });
    }

    case 'turn/start': {
      const turnId = `turn_${++turns}`;
      const threadId = msg.params?.threadId;
      const text = (msg.params?.input ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ');

      reply(msg.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });

      const command = { id: 'item_1', type: 'commandExecution', command: 'echo ok', cwd: process.cwd() };
      notify('item/started', { threadId, turnId, item: { ...command, status: 'inProgress' } });
      notify('item/completed', {
        threadId,
        turnId,
        item: { ...command, status: 'completed', aggregatedOutput: 'ok\n', exitCode: 0 },
      });

      // Deltas stream first; the adapter must ignore them and use the
      // completed item, so the feed gets one message rather than one per token.
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'item_2', delta: 'Working' });
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'item_2', delta: ' on it' });
      notify('item/completed', {
        threadId,
        turnId,
        item: { id: 'item_2', type: 'agentMessage', text: `Working on: ${text}` },
      });

      // Private thinking must never reach a shared room.
      notify('item/completed', {
        threadId,
        turnId,
        item: { id: 'item_3', type: 'reasoning', text: 'secret chain of thought' },
      });

      return notify('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'completed' },
      });
    }

    case 'turn/interrupt':
      return reply(msg.id, {});

    default:
      return reply(msg.id, {});
  }
});

rl.on('close', () => process.exit(0));
