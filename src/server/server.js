import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SessionManager } from '../core/session-manager.js';
import { can, denyReason } from '../core/permissions.js';
import { sanitizeText, sanitizeName } from '../core/sanitize.js';
import { catchupSummary, currentActivity } from '../core/catchup.js';
import { buildRoomSummary } from '../core/room-summary.js';
import { token } from '../core/ids.js';
import { VERSION } from '../version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PENDING_LIMIT = 100;

/**
 * Session server: rooms, presence, event fan-out, participant↔agent routing.
 * A room holds human participants and one or many agent sessions; the room
 * persists when agents detach or the host leaves. JSON over WebSocket at /ws —
 *   participant → create_session | join | rejoin | instruction | control |
 *                 add_agent | leave
 *   agent host  → agent_attach | agent_event
 *   server → participant: session_created | welcome | agent_added | event |
 *                         session | error
 *   server → agent host:  agent_attached | instruction | pause | resume |
 *                         handoff | end
 *
 * Security: joins from non-loopback connections need the room's join key
 * (requireJoinKey: 'auto' | true | false); listing/deleting rooms over HTTP
 * needs loopback or the admin token; join and HTTP requests are rate-limited
 * per remote address; all remote text is stripped of terminal control bytes.
 */
export function createCollagentServer({
  dataDir,
  log = () => {},
  requireJoinKey = 'auto',
  joinRateLimit = 30,
  httpRateLimit = 240,
  trustLoopback = true, // tests set false to exercise the remote-caller rules
} = {}) {
  const manager = new SessionManager({ dataDir });
  const restored = manager.restore();
  if (restored) log(`restored ${restored} room(s) from history`);
  const adminToken = loadAdminToken(dataDir);
  const participantConns = new Map(); // code -> Set<ws>
  const agentConns = new Map(); // code -> Map<agentId, ws>
  const rates = new Map(); // `${bucket}:${ip}` -> { count, resetAt }

  const httpServer = http.createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws._ctx = { role: null, code: null, participantId: null, agentId: null };
    ws._remote = req.socket.remoteAddress ?? '';
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

  // ---- rate limiting & auth ------------------------------------------------

  const isLoopback = (addr) => trustLoopback && LOOPBACK.has(addr);

  function overLimit(bucket, addr, max) {
    if (isLoopback(addr)) return false;
    const key = `${bucket}:${addr}`;
    const now = Date.now();
    const entry = rates.get(key);
    if (!entry || now > entry.resetAt) {
      rates.set(key, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    entry.count++;
    return entry.count > max;
  }

  function httpAuthorized(req) {
    if (isLoopback(req.socket.remoteAddress)) return true;
    const auth = req.headers.authorization ?? '';
    return Boolean(adminToken) && auth === `Bearer ${adminToken}`;
  }

  function roomReadAuthorized(req, url, session) {
    return httpAuthorized(req) || (session && url.searchParams.get('key') === session.joinKey);
  }

  function joinKeyOk(ws, session, key) {
    if (requireJoinKey === false) return true;
    if (requireJoinKey === 'auto' && isLoopback(ws._remote)) return true;
    return key === session.joinKey;
  }

  // ---- http ------------------------------------------------------------------

  function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (overLimit('http', req.socket.remoteAddress ?? '', httpRateLimit)) {
      return json(429, { error: 'rate limited' });
    }

    if (url.pathname === '/healthz') {
      return json(200, { ok: true, service: 'collagent', version: VERSION });
    }

    if (url.pathname === '/api/sessions') {
      if (!httpAuthorized(req)) return json(403, { error: 'forbidden' });
      const rooms = manager.list()
        .filter((s) => s.lifecycle !== 'archived' || url.searchParams.get('archived') === '1')
        .map((s) => s.summary())
        .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      return json(200, rooms);
    }

    const apiMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)(\/[a-z]+)?$/);
    if (apiMatch) {
      const session = manager.get(apiMatch[1]);
      const sub = apiMatch[2] ?? '';

      if (req.method === 'DELETE' && !sub) {
        if (!httpAuthorized(req)) return json(403, { error: 'forbidden' });
        const deleted = deleteRoom(apiMatch[1].toUpperCase());
        return json(deleted ? 200 : 404, deleted ? { ok: true } : { error: 'not found' });
      }
      if (!session) return json(404, { error: 'not found' });
      if (!roomReadAuthorized(req, url, session)) return json(403, { error: 'forbidden' });

      switch (sub) {
        case '':
          return json(200, session.summary());
        case '/agents':
          return json(200, [...session.agentSessions.values()].map((a) => a.toJSON()));
        case '/events': {
          const since = Number(url.searchParams.get('since') ?? 0);
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 500);
          const events = manager.store.readEvents(session.code, { since, limit })
            ?? session.log.since(since).slice(0, limit);
          return json(200, events);
        }
        case '/catchup': {
          const since = Number(url.searchParams.get('since') ?? 0);
          const snapshot = session.toJSON();
          return json(200, {
            lines: catchupSummary(session.log.since(since)),
            activity: currentActivity(snapshot),
            session: snapshot,
          });
        }
        case '/usage':
          return json(200, aggregateUsage(session));
        default:
          return json(404, { error: 'not found' });
      }
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
      case 'add_agent': return onAddAgent(ws, msg);
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

  function onCreateSession(ws, { name = 'host', agentType = 'unknown', userId = null }) {
    if (overLimit('join', ws._remote, joinRateLimit)) {
      return send(ws, { type: 'error', message: 'rate limited — try again shortly' });
    }
    const session = manager.create({ agentType }); // appends session_created
    const agent = session.addAgentSession({ adapterType: agentType });
    const p = session.addParticipant({ name: sanitizeName(name) || 'host', role: 'host', userId });
    agent.hostId = p.id;
    registerParticipant(ws, session, p);
    session.append('agent_session_created', sysActor(), { runtime: agent.runtime, adapterType: agentType },
      agentCtx(agent));
    broadcastEvent(session, session.append('participant_joined', userActor(p), { role: p.role }));
    manager.saveMeta(session);

    send(ws, {
      type: 'session_created',
      session: session.toJSON(),
      self: selfPayload(p),
      joinKey: session.joinKey,
      agentToken: agent.agentToken,
      agent: { agentId: agent.agentId, agentSessionId: agent.id },
      events: session.log.since(0),
    });
    broadcastSession(session);
    log(`session ${session.code} created by ${p.name}`);
  }

  function onJoin(ws, { code, name = 'guest', key = null, userId = null }) {
    if (overLimit('join', ws._remote, joinRateLimit)) {
      return send(ws, { type: 'error', message: 'rate limited — try again shortly' });
    }
    const session = manager.get(code);
    if (!session) return send(ws, { type: 'error', message: `no session with code ${code}` });
    if (session.lifecycle === 'ended') return send(ws, { type: 'error', message: 'session has ended' });
    if (!joinKeyOk(ws, session, key)) {
      return send(ws, { type: 'error', message: 'this room needs a join key — ask the host for the invite (collagent join CODE --key …)' });
    }
    if (session.lifecycle === 'archived') session.lifecycle = 'active';

    // A room with no connected host is adoptable: the first joiner takes over
    // and may re-attach its agents.
    const role = session.hasConnectedHost() ? 'collaborator' : 'host';
    const p = session.addParticipant({ name: sanitizeName(name) || 'guest', role, userId });
    registerParticipant(ws, session, p);
    broadcastEvent(session, session.append('participant_joined', userActor(p), { role: p.role }));
    manager.saveMeta(session);

    send(ws, {
      type: 'welcome',
      session: session.toJSON(),
      self: selfPayload(p),
      events: session.log.since(0),
      ...(p.role === 'host' ? { joinKey: session.joinKey } : {}),
      ...reattachGrant(session, p),
    });
    broadcastSession(session);
    log(`${p.name} joined session ${session.code}${role === 'host' ? ' (as host)' : ''}`);
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
      self: selfPayload(p),
      events: session.log.since(sinceSeq),
      resumed: true,
      ...(p.role === 'host' ? { joinKey: session.joinKey } : {}),
      ...reattachGrant(session, p),
    });
    broadcastSession(session);
  }

  // Detached agent sessions this participant may re-host, with fresh tokens.
  function reattachGrant(session, participant) {
    const mayHost = participant.role === 'host' || session.driverId === participant.id;
    if (!mayHost) return {};
    const detached = [...session.agentSessions.values()].filter((a) => !a.attached);
    if (!detached.length) return {};
    const grants = detached.map((a) => ({
      agentId: a.agentId,
      agentSessionId: a.id,
      adapterType: a.adapterType,
      nativeSessionId: a.nativeSessionId,
      agentToken: a.agentToken,
    }));
    const primary = grants.find((g) => g.agentId === session.primaryAgent()?.agentId) ?? grants[0];
    return {
      agents: grants,
      // legacy single-agent fields, still used by the create/open flow
      agentToken: primary.agentToken,
      agentSessionId: primary.nativeSessionId,
    };
  }

  function onLeave(ws) {
    const { session, participant } = resolveParticipant(ws);
    if (!session || !participant) return;
    broadcastEvent(session, session.append('participant_left', userActor(participant), {}));
    session.removeParticipant(participant.id);
    participantConns.get(session.code)?.delete(ws);
    ws._ctx = { role: null, code: null, participantId: null, agentId: null };
    manager.saveMeta(session);
    broadcastSession(session);
    // The room persists: agents may detach, people may leave — the work remains.
  }

  // ---- agent sessions -----------------------------------------------------

  function onAddAgent(ws, { agentType }) {
    const { session, participant } = resolveParticipant(ws);
    if (!session || !participant) return send(ws, { type: 'error', message: 'not in a session' });
    if (!can(session, participant, 'add_agent')) {
      return send(ws, { type: 'error', message: denyReason(session, participant, 'add_agent') });
    }
    if (!agentType || typeof agentType !== 'string') {
      return send(ws, { type: 'error', message: 'add_agent needs an agentType' });
    }
    const agent = session.addAgentSession({ adapterType: agentType, hostId: participant.id });
    broadcastEvent(session, session.append('agent_session_created', userActor(participant), {
      runtime: agent.runtime,
      adapterType: agentType,
    }, agentCtx(agent)));
    manager.saveMeta(session);
    send(ws, {
      type: 'agent_added',
      agent: agent.toJSON(),
      agentToken: agent.agentToken,
    });
    broadcastSession(session);
    log(`agent ${agent.agentId} added to ${session.code} by ${participant.name}`);
  }

  function onAgentAttach(ws, { code, agentToken }) {
    const session = manager.get(code);
    if (!session) return send(ws, { type: 'error', message: `no session with code ${code}` });
    const agent = session.agentSessionByToken(agentToken);
    if (!agent) return send(ws, { type: 'error', message: 'invalid agent token' });

    if (!agentConns.has(session.code)) agentConns.set(session.code, new Map());
    agentConns.get(session.code).set(agent.agentId, ws);
    ws._ctx = { role: 'agent', code: session.code, participantId: null, agentId: agent.agentId };
    agent.markAttached();
    broadcastEvent(session, session.append('agent_session_attached', agentActor(agent), {}, agentCtx(agent)));
    manager.saveMeta(session);
    send(ws, {
      type: 'agent_attached',
      session: session.toJSON(),
      agent: { agentId: agent.agentId, agentSessionId: agent.id },
    });
    broadcastSession(session);
    flushPending(session, agent, ws);
    log(`agent ${agent.agentId} attached to session ${session.code}`);
  }

  function flushPending(session, agent, agentWs) {
    const deliverable = [];
    session.pending = session.pending.filter((item) => {
      const addressed = item.to && item.to !== agent.agentId;
      if (addressed) return true; // stays queued for its own agent
      deliverable.push(item);
      return false;
    });
    if (!deliverable.length) return;
    broadcastEvent(session, session.append('notice', sysActor(), {
      message: `${agent.agentId} attached — delivering ${deliverable.length} queued instruction${deliverable.length === 1 ? '' : 's'}`,
    }, agentCtx(agent)));
    for (const item of deliverable) {
      send(agentWs, { type: 'instruction', text: item.text, from: item.from, eventSeq: item.eventSeq });
    }
    agent.status = 'working';
    broadcastSession(session);
  }

  function onAgentEvent(ws, { event, turnId = null }) {
    const session = ws._ctx.role === 'agent' ? manager.get(ws._ctx.code) : null;
    if (!session || !event?.kind) return;
    const agent = session.getAgentSession(ws._ctx.agentId);
    if (!agent) return;
    const { kind, ...data } = event;

    if (kind === 'agent_status') {
      agent.applyAgentStatus(data.status);
      if (data.status === 'ready') {
        if (data.detail?.sessionId) agent.nativeSessionId = data.detail.sessionId;
        if (agent.agentId === session.primaryAgent()?.agentId) {
          session.agentInfo = data.detail ?? null;
        }
        manager.saveMeta(session);
      }
    }
    if (kind === 'turn_started') agent.currentTurnId = data.turnId ?? turnId;
    if (kind === 'turn_completed' || kind === 'turn_failed') agent.currentTurnId = null;

    broadcastEvent(session, session.append(kind, agentActor(agent), data, agentCtx(agent, turnId ?? data.turnId)));
    broadcastSession(session);
  }

  // ---- instructions & control ------------------------------------------

  function onInstruction(ws, { text, to = null }) {
    const { session, participant } = resolveParticipant(ws);
    if (!session || !participant) return send(ws, { type: 'error', message: 'not in a session' });
    text = sanitizeText(text);
    if (!text || !String(text).trim()) return;

    if (!can(session, participant, 'instruct')) {
      return send(ws, { type: 'error', message: denyReason(session, participant, 'instruct') });
    }

    // Resolve the target agent session. Single-agent rooms never require
    // addressing — plain text goes to the only agent, exactly as before.
    let target = null;
    if (to) {
      target = session.findAgentSession(to);
      if (!target) {
        return send(ws, { type: 'error', message: `no agent "${to}" here — agents: ${agentRoster(session) || 'none'}` });
      }
      participant.defaultAgentId = target.agentId;
    } else {
      const attached = session.attachedAgents();
      if (attached.length === 1) target = attached[0];
      else if (attached.length > 1) {
        target = attached.find((a) => a.agentId === participant.defaultAgentId)
          ?? attached.find((a) => a.agentId === session.defaultAgentId)
          ?? null;
        if (!target) {
          return send(ws, {
            type: 'error',
            message: `several agents are here — address one (@${attached[0].agentId} …) or pick a default (/use ${attached[0].agentId}). Agents: ${agentRoster(session)}`,
          });
        }
      } else if (session.agentSessions.size === 1) {
        target = session.primaryAgent(); // detached — instruction will queue
      }
    }

    const event = session.append('instruction', userActor(participant), { text },
      target ? { agentId: target.agentId, agentSessionId: target.id } : {});
    broadcastEvent(session, event);

    const agentWs = target && agentConns.get(session.code)?.get(target.agentId);
    if (!agentWs || agentWs.readyState !== agentWs.OPEN) {
      if (session.pending.length >= PENDING_LIMIT) {
        return broadcastEvent(session, session.append('error', sysActor(), {
          message: 'no agent attached and the queue is full — attach an agent first',
        }));
      }
      session.pending.push({ text, from: { id: participant.id, name: participant.name }, eventSeq: event.seq, to: target?.agentId ?? null });
      broadcastEvent(session, session.append('notice', sysActor(), {
        message: `${target ? target.agentId + ' is' : 'no agent'} not attached — instruction queued (${session.pending.length}). It is delivered when an agent attaches (collagent open ${session.code}).`,
      }));
      return;
    }

    if (!session.paused) {
      target.status = 'working';
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
    const conns = agentConns.get(session.code) ?? new Map();

    switch (action) {
      case 'pause': {
        session.paused = true;
        broadcastEvent(session, session.append('session_paused', userActor(participant), {}));
        for (const agentWs of conns.values()) send(agentWs, { type: 'pause' });
        break;
      }
      case 'resume': {
        session.paused = false;
        broadcastEvent(session, session.append('session_resumed', userActor(participant), {}));
        for (const agentWs of conns.values()) send(agentWs, { type: 'resume' });
        break;
      }
      case 'handoff':
        return onHandoff(ws, session, participant, target);
      case 'use_agent': {
        const agent = session.findAgentSession(target);
        if (!agent) {
          return send(ws, { type: 'error', message: `no agent "${target}" — agents: ${agentRoster(session) || 'none'}` });
        }
        participant.defaultAgentId = agent.agentId;
        return send(ws, { type: 'ok', message: `instructions now go to ${agent.agentId}` });
      }
      case 'detach_agent': {
        const agent = session.findAgentSession(target);
        if (!agent) {
          return send(ws, { type: 'error', message: `no agent "${target}" — agents: ${agentRoster(session) || 'none'}` });
        }
        conns.get(agent.agentId)?.close();
        if (agent.attached) detachAgent(session, agent);
        break;
      }
      case 'set_mode': {
        if (!['open', 'driver'].includes(mode)) {
          return send(ws, { type: 'error', message: 'mode must be "open" or "driver"' });
        }
        session.mode = mode;
        broadcastEvent(session, session.append('mode_changed', userActor(participant), { mode }));
        manager.saveMeta(session);
        break;
      }
      case 'archive': {
        session.lifecycle = 'archived';
        broadcastEvent(session, session.append('room_archived', userActor(participant), {}));
        manager.saveMeta(session);
        break;
      }
      case 'end': {
        broadcastEvent(session, session.append('session_ended', userActor(participant), {}));
        for (const agentWs of conns.values()) {
          send(agentWs, { type: 'end' });
          agentWs.close();
        }
        manager.end(session.code);
        broadcastSession(session);
        for (const conn of participantConns.get(session.code) ?? []) conn.close();
        return;
      }
      default:
        return send(ws, { type: 'error', message: `unknown control action: ${action}` });
    }
    broadcastSession(session);
  }

  // Handoff is first-class: human → human moves the driver seat, any → agent
  // moves the room's instruction focus. Both persist a structured event with
  // the shared context the receiver needs.
  function onHandoff(ws, session, participant, target) {
    const context = handoffContext(session);
    const human = session.getParticipant(target) ?? session.findParticipantByName(String(target ?? '').replace(/^@/, ''));
    if (human) {
      session.driverId = human.id;
      broadcastEvent(session, session.append('handoff_completed', userActor(participant), {
        to: { type: 'human', id: human.id, name: human.name },
        context,
      }));
      manager.saveMeta(session);
      for (const agentWs of (agentConns.get(session.code) ?? new Map()).values()) {
        send(agentWs, { type: 'handoff', to: { id: human.id, name: human.name } });
      }
      broadcastSession(session);
      return;
    }
    const agent = session.findAgentSession(target);
    if (!agent) {
      return send(ws, { type: 'error', message: `no participant or agent "${target}"` });
    }
    session.defaultAgentId = agent.agentId;
    broadcastEvent(session, session.append('handoff_completed', userActor(participant), {
      to: { type: 'agent', id: agent.agentId, name: agent.agentId },
      context,
    }, agentCtx(agent)));
    const agentWs = agentConns.get(session.code)?.get(agent.agentId);
    if (agentWs) {
      send(agentWs, {
        type: 'instruction',
        text: handoffBrief(participant, context),
        from: { id: participant.id, name: participant.name },
      });
      agent.status = 'working';
    }
    broadcastSession(session);
  }

  function handoffContext(session) {
    const summary = buildRoomSummary(session.log.events);
    const recent = session.log.events
      .filter((e) => e.kind === 'instruction' || e.kind === 'local_prompt')
      .slice(-3)
      .map((e) => ({ name: e.actor?.name ?? 'someone', text: e.data?.text ?? '' }));
    return {
      objective: summary.title ?? null,
      recent,
      agents: [...session.agentSessions.values()].map((a) => ({
        agentId: a.agentId,
        status: a.attached ? a.status : 'detached',
      })),
      mode: session.mode,
    };
  }

  function handoffBrief(fromParticipant, context) {
    const lines = [`Handoff from ${fromParticipant.name}: you now have the room's focus.`];
    if (context.objective) lines.push(`Objective: ${context.objective}`);
    if (context.recent.length) {
      lines.push('Recent direction:');
      for (const r of context.recent) lines.push(`- ${r.name}: ${r.text}`);
    }
    const others = context.agents.filter((a) => a.status !== 'detached');
    if (others.length > 1) {
      lines.push(`Other agents in the room: ${others.map((a) => `${a.agentId} (${a.status})`).join(', ')}`);
    }
    lines.push('Continue from the shared context above; ask in the room if anything is missing.');
    return lines.join('\n');
  }

  // Ends a live room (everyone is disconnected) and removes its history.
  function deleteRoom(code) {
    const session = manager.get(code);
    if (session) {
      broadcastEvent(session, session.append('session_ended', sysActor(), { deleted: true }));
      for (const conn of participantConns.get(session.code) ?? []) conn.close();
      for (const agentWs of (agentConns.get(session.code) ?? new Map()).values()) agentWs.close();
      manager.end(session.code);
      log(`room ${code} deleted`);
    }
    const removedFile = manager.deleteHistory(code);
    return Boolean(session) || removedFile;
  }

  // ---- helpers -----------------------------------------------------------

  function detachAgent(session, agent) {
    agent.markDetached();
    broadcastEvent(session, session.append('agent_session_detached', agentActor(agent), {}, agentCtx(agent)));
    manager.saveMeta(session);
    broadcastSession(session);
  }

  function agentRoster(session) {
    return [...session.agentSessions.values()]
      .map((a) => `${a.agentId}${a.attached ? '' : ' (detached)'}`)
      .join(', ');
  }

  function aggregateUsage(session) {
    const byAgent = new Map();
    for (const e of session.log.events) {
      if (e.kind !== 'turn_completed' && e.kind !== 'turn_failed') continue;
      const key = e.agentId ?? 'agent';
      if (!byAgent.has(key)) {
        byAgent.set(key, {
          agentId: key,
          turns: 0,
          toolCalls: 0,
          durationMs: 0,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          providerCost: null,
          currency: null,
        });
      }
      const row = byAgent.get(key);
      row.turns++;
      const u = e.data?.usage ?? {};
      row.toolCalls += e.data?.toolCalls ?? 0;
      row.durationMs += e.data?.durationMs ?? 0;
      for (const [field, value] of Object.entries({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        providerCost: u.providerCost,
      })) {
        if (typeof value === 'number') row[field] = (row[field] ?? 0) + value;
      }
      if (u.currency) row.currency = u.currency;
    }
    return [...byAgent.values()];
  }

  function registerParticipant(ws, session, participant) {
    ws._ctx = { role: 'participant', code: session.code, participantId: participant.id, agentId: null };
    if (!participantConns.has(session.code)) participantConns.set(session.code, new Set());
    participantConns.get(session.code).add(ws);
  }

  function resolveParticipant(ws) {
    if (ws._ctx.role !== 'participant') return {};
    const session = manager.get(ws._ctx.code);
    return { session, participant: session?.getParticipant(ws._ctx.participantId) };
  }

  function handleClose(ws) {
    const { role, code, participantId, agentId } = ws._ctx ?? {};
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
      const conns = agentConns.get(code);
      if (conns?.get(agentId) === ws) conns.delete(agentId);
      const agent = session.getAgentSession(agentId);
      if (agent?.attached && session.lifecycle !== 'ended') {
        broadcastEvent(session, session.append('agent_status', agentActor(agent), { status: 'disconnected' }, agentCtx(agent)));
        detachAgent(session, agent);
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

  const selfPayload = (p) => ({ participantId: p.id, resumeToken: p.resumeToken, name: p.name });
  const sysActor = () => ({ type: 'system', name: 'collagent' });
  const userActor = (p) => ({ type: 'user', id: p.id, name: p.name });
  const agentActor = (a) => ({ type: 'agent', id: a.agentId, name: a.agentId });
  const agentCtx = (a, turnId = null) => ({
    agentId: a.agentId,
    agentSessionId: a.id,
    ...(turnId ? { turnId } : {}),
  });

  return {
    httpServer,
    manager,
    adminToken,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address())));
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      manager.close();
      return new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

// The admin token gates room listing/deletion for non-loopback callers. It
// lives beside the data (0600) so local tooling can read it; remote admins
// copy it once.
function loadAdminToken(dataDir) {
  if (!dataDir) return null;
  const file = path.join(dataDir, 'admin-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first boot */ }
  const fresh = token();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
  } catch {
    return null;
  }
  return fresh;
}
