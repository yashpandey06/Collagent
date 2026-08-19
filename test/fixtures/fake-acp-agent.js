#!/usr/bin/env node
// Speaks the ACP wire format (agentclientprotocol.com): initialize handshake,
// session/new|load, session/prompt with streamed session/update notifications
// (chunked prose, tool calls) and a permission request mid-turn.
import { createInterface } from 'node:readline';

let loaded = false;
let pendingPermission = null;

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'initialize') {
    return send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'fake-acp', version: '1.0.0' },
      },
    });
  }
  if (msg.method === 'session/new') {
    return send({ id: msg.id, result: { sessionId: 'acp-123' } });
  }
  if (msg.method === 'session/load') {
    loaded = true;
    return send({ id: msg.id, result: {} });
  }
  if (msg.method === 'session/prompt') {
    const { sessionId } = msg.params;
    const promptText = msg.params.prompt?.[0]?.text ?? '';
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wor' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `king on: ${promptText}${loaded ? ' (resumed)' : ''}` } });
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thinking' } });
    update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 't1', title: 'shell', rawInput: { command: 'ls' },
    });
    // a permission request the client must answer before the turn can finish
    send({
      id: 999,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 't1', title: 'shell' },
        options: [
          { id: 'opt-allow', label: 'Allow', kind: 'allow_once' },
          { id: 'opt-reject', label: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    pendingPermission = { promptId: msg.id, sessionId };
    return;
  }
  // the client's answer to our permission request
  if (msg.id === 999 && !msg.method) {
    const { promptId, sessionId } = pendingPermission;
    pendingPermission = null;
    const approved = msg.result?.outcome?.outcome === 'selected';
    update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'shell',
      status: approved ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'file-a file-b' } }],
    });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' All done.' } });
    return send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
});
