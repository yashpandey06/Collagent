import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SessionManager } from '../core/session-manager.js';
import { can, denyReason } from '../core/permissions.js';
import { VERSION } from '../version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Collagent session server: session registry, participant presence,
 * event fan-out and routing between participants and the agent adapter.
 *
 * Transport protocol (JSON over WebSocket at /ws):
 *   participant -> server: create_session | join | rejoin | instruction |
 *                          control | leave
 *   agent host  -> server: agent_attach | agent_event
 *   server -> participant: session_created | welcome | event | session | error
 *   server -> agent host:  agent_attached | instruction | pause | resume |
 *                          handoff | end
 */
export function createCollagentServer({ dataDir, log = () => {} } = {}) {
  const manager = new SessionManager({ dataDir });
  const restored = manager.restore();
  if (restored) log(`restored ${restored} room(s) from history`);
  const participantConns = new Map(); // code -> Set<ws>
  const agentConns = new Map(); // code -> ws

  const httpServer = http.createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    ws._ctx = { role: null, code: null, participantId: null };
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: 'error', message: 'invalid JSON' });
      }
      try {
        handleMessage(ws, msg);
      } catch (err) {
        log('handler error', err);
        send(ws, { type: 'error', message: err.message });
      }
    });
    ws.on('close', () => handleClose(ws));
  });

  function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'collagent', version: VERSION }));
    }
    if (url.pathname === '/api/sessions') {
      const rooms = manager.list()
        .map((s) => s.summary())
        .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(rooms));
    }
    const apiMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)$/);
    if (apiMatch) {
      const session = manager.get(apiMatch[1]);
      res.writeHead(session ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(session ? session.summary() : { error: 'not found' }));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const html = fs.readFileSync(path.join(__dirname, 'web', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        res.writeHead(500);
        return res.end('web ui missing');
      }
    }
    res.writeHead(404);
    res.end('not found');
  }

  function handleMessage(ws, msg) {
    switch (msg.type) {
      case 'create_session': return onCreateSession(ws, msg);
      case 'join': return onJoin(ws, msg);
      case 'rejoin': return onRejoin(ws, msg);
      case 'agent_attach': return onAgentAttach(ws, msg);
      case 'agent_event': return onAgentEvent(ws, msg);
      case 'instruction': return onInstruction(ws, msg);
      case 'control': return onControl(ws, msg);
      case 'leave': return onLeave(ws);
      default:
        return send(ws, { type: 'error', message: `unknown message type: ${msg.type}` });
    }
  }

  // ---- participant lifecycle -------------------------------------------

  function onCreateSession(ws, { name = 'host', agentType = 'claude-code' }) {
    const session = manager.create({ agentType }); // appends session_created
    const p = session.addParticipant({ name, role: 'host' });
    registerParticipant(ws, session, p);
    broadcastEvent(session, session.append('participant_joined', userActor(p), { role: p.role }));

    send(ws, {
      type: 'session_created',
      session: session.toJSON(),
      self: { participantId: p.id, resumeToken: p.resumeToken, name: p.name },
      agentToken: session.agentToken,
      events: session.log.since(0),
    });
    broadcastSession(session);
    log(`session ${session.code} created by ${name}`);
  }

  function onJoin(ws, { code, name = 'guest' }) {
    const session = manager.get(code);
    if (!session) return send(ws, { type: 'error', message: `no session with code ${code}` });
    if (session.status === 'ended') return send(ws, { type: 'error', message: 'session has ended' });

    // A restored room has no host; the first joiner takes over as host and
    // may re-attach an agent (welcome carries the credentials to do so).
    const role = session.hasHost() ? 'collaborator' : 'host';
    const p = session.addParticipant({ name, role });
    registerParticipant(ws, session, p);
    broadcastEvent(session, session.append('participant_joined', userActor(p), { role: p.role }));

    const canHostAgent = role === 'host' && !agentConns.has(session.code);
    send(ws, {
      type: 'welcome',
      session: session.toJSON(),
      self: { participantId: p.id, resumeToken: p.resumeToken, name: p.name },
      events: session.log.since(0),
      ...(canHostAgent && {
        agentToken: session.agentToken,
        agentSessionId: session.lastAgentSessionId(),
      }),
    });
    broadcastSession(session);
    log(`${name} joined session ${session.code}${role === 'host' ? ' (as host)' : ''}`);
  }

  function onRejoin(ws, { code, participantId, resumeToken, sinceSeq = 0 }) {
    const session = manager.get(code);
    if (!session) return send(ws, { type: 'error', message: `no session with code ${code}` });
    const p = session.getParticipant(participantId);
    if (!p || p.resumeToken !== resumeToken) {
      return send(ws, { type: 'error', message: 'invalid resume credentials' });
    }
    p.connected = true;
    registerParticipant(ws, session, p);
    broadcastEvent(session, session.append('participant_reconnected', userActor(p), {}));
    send(ws, {
      type: 'welcome',
      session: session.toJSON(),
      self: { participantId: p.id, resumeToken: p.resumeToken, name: p.name },
      events: session.log.since(sinceSeq),
      resumed: true,
    });
    broadcastSession(session);
  }

  function onLeave(ws) {
    const { session, participant } = resolveParticipant(ws);
    if (!session || !participant) return;
    broadcastEvent(session, session.append('participant_left', userActor(participant), {}));
    session.removeParticipant(participant.id);
    participantConns.get(session.code)?.delete(ws);
    ws._ctx = { role: null, code: null, participantId: null };
    broadcastSession(session);
  }

  // ---- agent adapter connection ----------------------------------------

  function onAgentAttach(ws, { code, agentToken }) {
    const session = manager.get(code);
    if (!session) return send(ws, { type: 'error', message: `no session with code ${code}` });
    if (agentToken !== session.agentToken) {
      return send(ws, { type: 'error', message: 'invalid agent token' });
    }
    agentConns.set(session.code, ws);
    ws._ctx = { role: 'agent', code: session.code, participantId: null };
    send(ws, { type: 'agent_attached', session: session.toJSON() });
    log(`agent attached to session ${session.code}`);
  }

  function onAgentEvent(ws, { event }) {
    const session = ws._ctx.role === 'agent' ? manager.get(ws._ctx.code) : null;
    if (!session || !event?.kind) return;
    const { kind, ...data } = event;

    if (kind === 'agent_status') {
      session.agentStatus = data.status;
      if (data.status === 'ready') {
        session.agentInfo = data.detail ?? null;
      }
      applyAgentStatus(session);
    }
    broadcastEvent(session, session.append(kind, agentActor(session), data));
    broadcastSession(session);
  }

  // ---- instructions & control ------------------------------------------

  function onInstruction(ws, { text }) {
    const { session, participant } = resolveParticipant(ws);
    if (!session || !participant) return send(ws, { type: 'error', message: 'not in a session' });
    if (!text || !String(text).trim()) return;

    if (!can(session, participant, 'instruct')) {
      return send(ws, { type: 'error', message: denyReason(session, participant, 'instruct') });
    }

    const event = session.append('instruction', userActor(participant), { text });
    broadcastEvent(session, event);

    const agentWs = agentConns.get(session.code);
    if (!agentWs || agentWs.readyState !== agentWs.OPEN) {
      broadcastEvent(session, session.append('error', sysActor(), {
        message: 'agent is not connected — instruction queued nowhere',
      }));
      return;
    }
    if (session.status !== 'paused') {
      session.status = 'working';
      broadcastSession(session);
    }
    send(agentWs, {
      type: 'instruction',
      text,
      from: { id: participant.id, name: participant.name },
      eventSeq: event.seq,
    });
  }

  function onControl(ws, { action, target, mode }) {
    const { session, participant } = resolveParticipant(ws);
    if (!session || !participant) return send(ws, { type: 'error', message: 'not in a session' });
    if (!can(session, participant, action)) {
      return send(ws, { type: 'error', message: denyReason(session, participant, action) });
    }
    const agentWs = agentConns.get(session.code);

    switch (action) {
      case 'pause': {
        session.status = 'paused';
        broadcastEvent(session, session.append('session_paused', userActor(participant), {}));
        if (agentWs) send(agentWs, { type: 'pause' });
        break;
      }
      case 'resume': {
        applyAgentStatus(session, /* force */ true);
        broadcastEvent(session, session.append('session_resumed', userActor(participant), {}));
        if (agentWs) send(agentWs, { type: 'resume' });
        break;
      }
      case 'handoff': {
        const to = session.getParticipant(target) ?? session.findParticipantByName(target);
        if (!to) return send(ws, { type: 'error', message: `no participant "${target}"` });
        session.driverId = to.id;
        broadcastEvent(session, session.append('control_transferred', userActor(participant), {
          to: { id: to.id, name: to.name },
        }));
        if (agentWs) send(agentWs, { type: 'handoff', to: { id: to.id, name: to.name } });
        break;
      }
      case 'set_mode': {
        if (!['open', 'driver'].includes(mode)) {
          return send(ws, { type: 'error', message: 'mode must be "open" or "driver"' });
        }
        session.mode = mode;
        broadcastEvent(session, session.append('mode_changed', userActor(participant), { mode }));
        break;
      }
      case 'end': {
        broadcastEvent(session, session.append('session_ended', userActor(participant), {}));
        if (agentWs) send(agentWs, { type: 'end' });
        session.status = 'ended';
        broadcastSession(session);
        for (const conn of participantConns.get(session.code) ?? []) conn.close();
        agentWs?.close();
        manager.end(session.code);
        return;
      }
      default:
        return send(ws, { type: 'error', message: `unknown control action: ${action}` });
    }
    broadcastSession(session);
  }

  // ---- helpers -----------------------------------------------------------

  function applyAgentStatus(session, force = false) {
    if (session.status === 'ended') return;
    if (session.status === 'paused' && !force) return; // pause gate wins
    const map = { ready: 'idle', idle: 'idle', working: 'working', exited: 'waiting_agent', disconnected: 'waiting_agent' };
    session.status = map[session.agentStatus] ?? (force ? 'idle' : session.status);
  }

  function registerParticipant(ws, session, participant) {
    ws._ctx = { role: 'participant', code: session.code, participantId: participant.id };
    if (!participantConns.has(session.code)) participantConns.set(session.code, new Set());
    participantConns.get(session.code).add(ws);
  }

  function resolveParticipant(ws) {
    if (ws._ctx.role !== 'participant') return {};
    const session = manager.get(ws._ctx.code);
    return { session, participant: session?.getParticipant(ws._ctx.participantId) };
  }

  function handleClose(ws) {
    const { role, code, participantId } = ws._ctx ?? {};
    if (!code) return;
    const session = manager.get(code);
    if (!session) return;

    if (role === 'participant') {
      participantConns.get(code)?.delete(ws);
      const p = session.getParticipant(participantId);
      if (p && p.connected) {
        p.connected = false;
        broadcastEvent(session, session.append('participant_disconnected', userActor(p), {}));
        broadcastSession(session);
      }
    } else if (role === 'agent') {
      if (agentConns.get(code) === ws) agentConns.delete(code);
      if (session.status !== 'ended') {
        session.agentStatus = 'disconnected';
        applyAgentStatus(session);
        broadcastEvent(session, session.append('agent_status', agentActor(session), { status: 'disconnected' }));
        broadcastSession(session);
      }
    }
  }

  function broadcastEvent(session, event) {
    const payload = JSON.stringify({ type: 'event', event });
    for (const conn of participantConns.get(session.code) ?? []) {
      if (conn.readyState === conn.OPEN) conn.send(payload);
    }
  }

  function broadcastSession(session) {
    const payload = JSON.stringify({ type: 'session', session: session.toJSON() });
    for (const conn of participantConns.get(session.code) ?? []) {
      if (conn.readyState === conn.OPEN) conn.send(payload);
    }
  }

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  const sysActor = () => ({ type: 'system', name: 'collagent' });
  const userActor = (p) => ({ type: 'user', id: p.id, name: p.name });
  const agentActor = (s) => ({ type: 'agent', name: s.agentType });

  return {
    httpServer,
    manager,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address())));
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => httpServer.close(resolve));
    },
  };
}
