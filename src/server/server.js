import http from 'node:http';
import https from 'node:https';
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
import { registerUser, resolveUser, personalWorkspaceId } from './auth.js';
import { buildOverview, buildAnalytics } from './analytics.js';
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
const envBool = (v) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : undefined);

export function createCollagentServer({
  dataDir,
  databaseUrl,
  log = () => {},
  requireJoinKey = envBool(process.env.COLLAGENT_REQUIRE_JOIN_KEY) ?? true,
  requireAuth = envBool(process.env.COLLAGENT_REQUIRE_AUTH) ?? 'auto',
  joinRateLimit = 30,
  httpRateLimit = 240,
  trustLoopback = true, // tests set false to exercise the remote-caller rules
  trustProxy = envBool(process.env.COLLAGENT_TRUST_PROXY) ?? false,
  corsOrigins = (process.env.COLLAGENT_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  tls = null, // { cert, key } PEM strings — or terminate TLS at a proxy
  eventCache,
} = {}) {
  const manager = new SessionManager({ dataDir, databaseUrl, ...(eventCache ? { eventCache } : {}) });
  let restorePromise = null;
  const ensureRestored = () => {
    restorePromise ??= manager.restore().then((restored) => {
      if (restored) log(`restored ${restored} room(s)`, { backend: manager.store.backend, restored });
    });
    return restorePromise;
  };
  const adminToken = loadAdminToken(dataDir);
  const participantConns = new Map(); // code -> Set<ws>
  const agentConns = new Map(); // code -> Map<agentId, ws>
  const roomWatchers = new Map(); // code -> Set<ws> — dashboard observers, never participants
  const listWatchers = new Set(); // ws watching the rooms list (ws._scope: null = all, Set = allowed codes)
  const rates = new Map(); // `${bucket}:${ip}` -> { count, resetAt }

  const httpServer = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => handleHttp(req, res))
    : http.createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  // listen() rejects on bind errors; without this the re-emit on wss would crash
  wss.on('error', (err) => log('ws server error', { error: err.message }));

  // Behind a TLS-terminating proxy the socket peer is the proxy itself;
  // trustProxy switches identity to the forwarded client address.
  const remoteOf = (req) => (trustProxy
    ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress
    : req.socket.remoteAddress) ?? '';

  function originAllowed(origin) {
    if (!origin) return true;
    try {
      const { hostname } = new URL(origin);
      if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return true;
    } catch {
      return false;
    }
    return corsOrigins.includes('*') || corsOrigins.includes(origin);
  }

  wss.on('connection', (ws, req) => {
    if (!originAllowed(req.headers.origin)) {
      log('rejected ws from foreign origin', { origin: req.headers.origin });
      ws.close(1008, 'origin not allowed');
      return;
    }
    ws._ctx = { role: null, code: null, participantId: null, agentId: null };
    ws._remote = remoteOf(req);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: 'error', message: 'invalid JSON' });
      }
      Promise.resolve()
        .then(() => handleMessage(ws, msg))
        .catch((err) => {
          log('handler error', { error: err.message });
          send(ws, { type: 'error', message: err.message });
        });
    });
    ws.on('close', () => handleClose(ws));
  });

  // Reconnect-safe realtime: dead peers (no pong) are terminated so their
  // clients notice and resume from their event cursor.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, 30_000);
  heartbeat.unref?.();

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
    if (isLoopback(remoteOf(req))) return true;
    const auth = req.headers.authorization ?? '';
    return Boolean(adminToken) && auth === `Bearer ${adminToken}`;
  }

  const bearerOf = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || null;

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin || !corsOrigins.length) return false;
    if (!corsOrigins.includes('*') && !corsOrigins.includes(origin)) return false;
    res.setHeader('access-control-allow-origin', corsOrigins.includes('*') ? '*' : origin);
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-max-age', '600');
    return true;
  }

  function readJsonBody(req, maxBytes = 4096) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > maxBytes) {
          resolve(null);
          req.destroy();
        }
      });
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
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

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (overLimit('http', remoteOf(req), httpRateLimit)) {
      return json(429, { error: 'rate limited' });
    }

    if (url.pathname === '/healthz') {
      return json(200, { ok: true, service: 'collagent', version: VERSION });
    }
    if (url.pathname === '/readyz') {
      try {
        await ensureRestored();
        await manager.store.ping?.();
        return json(200, { ok: true, backend: manager.store.backend });
      } catch (err) {
        return json(503, { ok: false, error: err.message });
      }
    }

    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      if (overLimit('join', remoteOf(req), joinRateLimit)) return json(429, { error: 'rate limited' });
      const body = await readJsonBody(req);
      if (!body || typeof body.name !== 'string' || !body.name.trim()) {
        return json(400, { error: 'a display name is required' });
      }
      await ensureRestored();
      const account = await registerUser(manager.store, { name: body.name });
      log(`user registered`, { userId: account.userId, name: account.name });
      return json(201, account);
    }
    if (url.pathname === '/api/auth/whoami') {
      const user = await resolveUser(manager.store, bearerOf(req));
      return user ? json(200, user) : json(401, { error: 'invalid token' });
    }

    // Reads below share one visibility rule: loopback/admin see everything,
    // a user token sees their workspaces' rooms and rooms they sat in.
    async function visibleSessions() {
      if (httpAuthorized(req)) return manager.list();
      const user = await resolveUser(manager.store, bearerOf(req));
      if (!user) return null;
      const codes = await userScope(user);
      return manager.list().filter((s) => codes.has(s.code));
    }

    if (url.pathname === '/api/sessions') {
      const sessions = await visibleSessions();
      if (!sessions) return json(403, { error: 'forbidden' });
      const includeArchived = url.searchParams.get('archived') === '1';
      const rooms = sessions
        .filter((s) => s.lifecycle !== 'archived' || includeArchived)
        .map((s) => summaryWithKey(s))
        .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      return json(200, rooms);
    }

    if (url.pathname === '/api/overview') {
      const sessions = await visibleSessions();
      if (!sessions) return json(403, { error: 'forbidden' });
      return json(200, buildOverview(sessions));
    }

    if (url.pathname === '/api/analytics') {
      const sessions = await visibleSessions();
      if (!sessions) return json(403, { error: 'forbidden' });
      const sinceHours = Number(url.searchParams.get('sinceHours') ?? 24 * 7);
      return json(200, await buildAnalytics(sessions, {
        sinceTs: sinceHours > 0 ? Date.now() - sinceHours * 3_600_000 : 0,
        room: url.searchParams.get('room')?.toUpperCase() || null,
        runtime: url.searchParams.get('runtime') || null,
        readTurns: async (code) => {
          const completed = await manager.store.readEvents(code, { kind: 'turn_completed', limit: 1000 });
          if (completed === null) return null;
          const failed = (await manager.store.readEvents(code, { kind: 'turn_failed', limit: 1000 })) ?? [];
          return [...completed, ...failed];
        },
      }));
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
          return json(200, httpAuthorized(req) ? summaryWithKey(session) : session.summary());
        case '/agents':
          return json(200, [...session.agentSessions.values()].map((a) => a.toJSON()));
        case '/events': {
          const q = url.searchParams;
          const since = Number(q.get('since') ?? 0);
          const limit = Math.min(Number(q.get('limit') ?? 200), 500);
          const filters = {
            since,
            limit,
            kind: q.get('kind') ?? undefined,
            agentId: q.get('agentId') ?? undefined,
            turnId: q.get('turnId') ?? undefined,
            participantId: q.get('participantId') ?? undefined,
            afterTs: q.get('afterTs') ? Number(q.get('afterTs')) : undefined,
          };
          const events = (await manager.store.readEvents(session.code, filters))
            ?? session.log.since(since).slice(0, limit);
          return json(200, events);
        }
        case '/catchup': {
          const since = Number(url.searchParams.get('since') ?? 0);
          const snapshot = session.toJSON();
          return json(200, {
            lines: catchupSummary(await session.eventsSince(since)),
            activity: currentActivity(snapshot),
            session: snapshot,
          });
        }
        case '/usage':
          return json(200, await aggregateUsage(session));
        default:
          return json(404, { error: 'not found' });
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // invite links (/?code=A7K2) keep opening the lightweight room viewer;
      // the bare origin is the control dashboard
      return servePage(res, url.searchParams.get('code') ? 'room.html' : 'dashboard.html');
    }
    if (url.pathname === '/room') return servePage(res, 'room.html');
    // The docs are a separate static site (docs-site/dist, deployable on its
    // own); serving it here is a convenience for local use.
    if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
      return serveDocs(res, url.pathname);
    }
    res.writeHead(404);
    res.end('not found');
  }

  function servePage(res, name) {
    try {
      let html = fs.readFileSync(path.join(__dirname, 'web', name), 'utf8');
      // The dashboard links to the docs deployment; configurable, never hardcoded.
      html = html.replaceAll('__COLLAGENT_DOCS_URL__', process.env.COLLAGENT_DOCS_URL || '/docs/');
      // no-cache: browsers heuristically cache pages without this, leaving
      // people staring at a stale dashboard after upgrades
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('web ui missing');
    }
  }

  const DOCS_DIST = path.join(__dirname, '..', '..', 'docs-site', 'dist');
  const DOC_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

  function serveDocs(res, pathname) {
    const rel = pathname.replace(/^\/docs\/?/, '') || 'index.html';
    const file = path.resolve(DOCS_DIST, rel);
    const type = DOC_TYPES[path.extname(file)];
    if (!file.startsWith(DOCS_DIST + path.sep) || !type || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(fs.existsSync(DOCS_DIST) ? 'not found' : 'docs not built — run: npm run docs:build');
    }
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(file));
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
      case 'watch': return onWatch(ws, msg);
      case 'watch_room': return onWatchRoom(ws, msg);
      case 'unwatch_room': return onUnwatchRoom(ws, msg);
      case 'leave': return onLeave(ws);
      default:
        return send(ws, { type: 'error', message: `unknown message type: ${msg.type}` });
    }
  }

  // ---- dashboard observers -------------------------------------------------
  // Watchers consume the same canonical event/session frames as participants
  // but never appear in the room. Visibility follows the HTTP read rules:
  // loopback and the admin token see everything; a user token sees their
  // workspaces' rooms and rooms they sat in; a join key opens one room.

  // Rooms a user may see: their workspaces' rooms + rooms they sat in.
  // Computed from the live sessions, so a room created seconds ago counts.
  async function userScope(user) {
    const workspaces = new Set((await manager.store.listWorkspacesFor(user.id)).map((w) => w.id));
    return new Set(manager.list()
      .filter((s) => (s.workspaceId && workspaces.has(s.workspaceId))
        || [...s.participants.values()].some((p) => p.userId === user.id))
      .map((s) => s.code));
  }

  async function watchScope(ws, msg) {
    if (isLoopback(ws._remote) || (msg.auth?.admin && msg.auth.admin === adminToken)) return null;
    const user = await authenticate(ws, msg);
    if (!user) return false;
    return await userScope(user);
  }

  async function onWatch(ws, msg) {
    const scope = await watchScope(ws, msg);
    if (scope === false) return send(ws, { type: 'error', message: AUTH_HINT });
    ws._scope = scope;
    listWatchers.add(ws);
    if (!ws._ctx.role) ws._ctx.role = 'watcher';
    send(ws, { type: 'rooms', rooms: visibleRooms(ws) });
  }

  const summaryWithKey = (session) => ({ ...session.summary(), joinKey: session.joinKey });

  function visibleRooms(ws) {
    return manager.list()
      .filter((s) => !ws._scope || ws._scope.has(s.code))
      .map((s) => summaryWithKey(s))
      .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }

  async function onWatchRoom(ws, msg) {
    const { code, key = null, sinceSeq = 0 } = msg;
    const session = manager.get(code);
    if (!session) return send(ws, { type: 'error', message: `no session with code ${code}` });

    let allowed = isLoopback(ws._remote)
      || (msg.auth?.admin && msg.auth.admin === adminToken)
      || key === session.joinKey;
    if (!allowed) {
      const user = await authenticate(ws, msg);
      allowed = Boolean(user) && (
        [...session.participants.values()].some((p) => p.userId === user.id)
        || (session.workspaceId && await manager.store.isMember(session.workspaceId, user.id))
      );
    }
    if (!allowed) return send(ws, { type: 'error', message: 'not authorized to watch this room' });

    if (!roomWatchers.has(session.code)) roomWatchers.set(session.code, new Set());
    roomWatchers.get(session.code).add(ws);
    (ws._watching ??= new Set()).add(session.code);
    if (!ws._ctx.role) ws._ctx.role = 'watcher';
    send(ws, {
      type: 'room_snapshot',
      session: session.toJSON(),
      events: await session.eventsSince(sinceSeq),
    });
  }

  function onUnwatchRoom(ws, { code }) {
    const c = String(code ?? '').toUpperCase();
    roomWatchers.get(c)?.delete(ws);
    ws._watching?.delete(c);
  }

  function notifyWatchers(session) {
    if (!listWatchers.size) return;
    const summary = summaryWithKey(session);
    for (const ws of listWatchers) {
      if (ws._scope && !ws._scope.has(session.code)) continue;
      send(ws, { type: 'room_update', room: summary });
    }
  }

  function notifyRoomRemoved(code) {
    for (const ws of listWatchers) {
      if (ws._scope && !ws._scope.has(code)) continue;
      send(ws, { type: 'room_removed', code });
    }
    for (const ws of roomWatchers.get(code) ?? []) {
      send(ws, { type: 'room_removed', code });
    }
    roomWatchers.delete(code);
  }

  // ---- participant lifecycle -------------------------------------------

  // Hosted mode requires a registered user; loopback development does not.
  const authRequired = (ws) => requireAuth === true || (requireAuth === 'auto' && !isLoopback(ws._remote));

  async function authenticate(ws, msg) {
    if (ws._user) return ws._user;
    const user = await resolveUser(manager.store, msg.auth?.token);
    if (user) ws._user = user;
    return user;
  }

  const AUTH_HINT = 'authentication required — register once: POST /api/auth/register {"name":"you"} and pass the token';

  async function onCreateSession(ws, msg) {
    const { name = 'host', agentType = 'unknown', userId = null, workspaceId = null, seat = true } = msg;
    if (overLimit('join', ws._remote, joinRateLimit)) {
      return send(ws, { type: 'error', message: 'rate limited — try again shortly' });
    }
    const user = await authenticate(ws, msg);
    if (authRequired(ws) && !user) {
      return send(ws, { type: 'error', message: AUTH_HINT });
    }
    const session = manager.create({ agentType }); // appends session_created
    if (user) {
      const personal = personalWorkspaceId(user.id);
      await manager.store.ensureWorkspace({ id: personal, name: `${user.name}'s workspace`, ownerId: user.id });
      session.workspaceId = workspaceId && (await manager.store.isMember(workspaceId, user.id))
        ? workspaceId
        : personal;
    }
    const agent = session.addAgentSession({ adapterType: agentType });
    let p = null;
    if (seat) {
      p = session.addParticipant({ name: sanitizeName(name) || 'host', role: 'host', userId: user?.id ?? userId });
      agent.hostId = p.id;
      registerParticipant(ws, session, p);
    }
    session.append('agent_session_created', sysActor(), { runtime: agent.runtime, adapterType: agentType },
      agentCtx(agent));
    if (p) broadcastEvent(session, session.append('participant_joined', userActor(p), { role: p.role }));
    manager.saveMeta(session);

    send(ws, {
      type: 'session_created',
      session: session.toJSON(),
      ...(p ? { self: selfPayload(p) } : {}),
      joinKey: session.joinKey,
      agentToken: agent.agentToken,
      agent: { agentId: agent.agentId, agentSessionId: agent.id },
      events: session.log.since(0),
    });
    broadcastSession(session);
    log(`session ${session.code} created by ${p?.name ?? 'the dashboard (no seat)'}`);
  }

  async function onJoin(ws, msg) {
    const { code, name = 'guest', key = null, userId = null } = msg;
    if (overLimit('join', ws._remote, joinRateLimit)) {
      return send(ws, { type: 'error', message: 'rate limited — try again shortly' });
    }
    const session = manager.get(code);
    if (!session) return send(ws, { type: 'error', message: `no session with code ${code}` });
    if (session.lifecycle === 'ended') return send(ws, { type: 'error', message: 'session has ended' });

    const user = await authenticate(ws, msg);
    if (authRequired(ws) && !user) {
      return send(ws, { type: 'error', message: AUTH_HINT });
    }
    // Authorization: the join key, workspace membership, or having sat in
    // this room before — any one admits.
    const wasHere = user && [...session.participants.values()].some((x) => x.userId === user.id);
    const isMember = user && session.workspaceId
      ? await manager.store.isMember(session.workspaceId, user.id)
      : false;
    if (!joinKeyOk(ws, session, key) && !wasHere && !isMember) {
      return send(ws, { type: 'error', message: 'this room needs a join key — ask the host for the invite (collagent join CODE --key …)' });
    }
    if (session.lifecycle === 'archived') session.lifecycle = 'active';

    // A room with no connected host is adoptable: the first joiner takes over
    // and may re-attach its agents.
    const role = session.hasConnectedHost() ? 'collaborator' : 'host';
    const p = session.addParticipant({ name: sanitizeName(name) || 'guest', role, userId: user?.id ?? userId });
    registerParticipant(ws, session, p);
    broadcastEvent(session, session.append('participant_joined', userActor(p), { role: p.role }));
    manager.saveMeta(session);

    send(ws, {
      type: 'welcome',
      session: session.toJSON(),
      self: selfPayload(p),
      events: await session.eventsSince(0),
      ...(p.role === 'host' ? { joinKey: session.joinKey } : {}),
      ...reattachGrant(session, p),
    });
    broadcastSession(session);
    log(`${p.name} joined session ${session.code}${role === 'host' ? ' (as host)' : ''}`);
  }

  async function onRejoin(ws, { code, participantId, resumeToken, sinceSeq = 0 }) {
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
      events: await session.eventsSince(sinceSeq),
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
    if (kind === 'turn_completed' || kind === 'turn_failed') {
      agent.currentTurnId = null;
      manager.store.saveTurn(session.code, {
        turnId: data.turnId ?? turnId,
        agentSessionId: agent.id,
        agentId: agent.agentId,
        ok: data.ok,
        durationMs: data.durationMs,
        toolCalls: data.toolCalls,
        usage: data.usage,
      });
    }

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

    const online = [...session.participants.values()].filter((p) => p.connected).length;
    const sender = online > 1
      ? { id: participant.id, name: participant.name }
      : { id: participant.id };

    const agentWs = target && agentConns.get(session.code)?.get(target.agentId);
    if (!agentWs || agentWs.readyState !== agentWs.OPEN) {
      if (session.pending.length >= PENDING_LIMIT) {
        return broadcastEvent(session, session.append('error', sysActor(), {
          message: 'no agent attached and the queue is full — attach an agent first',
        }));
      }
      session.pending.push({ text, from: sender, eventSeq: event.seq, to: target?.agentId ?? null });
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
      from: sender,
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
        notifyRoomRemoved(session.code);
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
      notifyRoomRemoved(session.code);
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

  async function aggregateUsage(session) {
    // Prefer the indexed store (complete history); fall back to the in-memory log.
    const fromStore = await manager.store.readEvents(session.code, { kind: 'turn_completed', limit: 1000 });
    const failed = fromStore !== null
      ? (await manager.store.readEvents(session.code, { kind: 'turn_failed', limit: 1000 })) ?? []
      : [];
    const source = fromStore !== null ? [...fromStore, ...failed] : session.log.events;
    const byAgent = new Map();
    for (const e of source) {
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
    listWatchers.delete(ws);
    for (const watched of ws._watching ?? []) roomWatchers.get(watched)?.delete(ws);
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
    for (const conn of roomWatchers.get(session.code) ?? []) {
      if (conn.readyState === conn.OPEN) conn.send(payload);
    }
  }

  const watcherDebounce = new Map(); // code -> timeout for rooms-list pushes

  function broadcastSession(session) {
    const payload = JSON.stringify({ type: 'session', session: session.toJSON() });
    for (const conn of participantConns.get(session.code) ?? []) {
      if (conn.readyState === conn.OPEN) conn.send(payload);
    }
    for (const conn of roomWatchers.get(session.code) ?? []) {
      if (conn.readyState === conn.OPEN) conn.send(payload);
    }
    // The rooms list needs summaries (a heavier fold) — debounce those pushes.
    if (listWatchers.size && !watcherDebounce.has(session.code)) {
      watcherDebounce.set(session.code, setTimeout(() => {
        watcherDebounce.delete(session.code);
        if (manager.get(session.code)) notifyWatchers(session);
      }, 250));
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
    async listen(port, host = '127.0.0.1') {
      await ensureRestored();
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve(httpServer.address());
        });
      });
    },
    /** Graceful: notify clients, stop accepting, flush persistence. */
    async shutdown() {
      clearInterval(heartbeat);
      for (const t of watcherDebounce.values()) clearTimeout(t);
      watcherDebounce.clear();
      for (const ws of wss.clients) {
        try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => httpServer.close(resolve));
      await manager.close();
    },
    async close() {
      clearInterval(heartbeat);
      for (const t of watcherDebounce.values()) clearTimeout(t);
      watcherDebounce.clear();
      for (const ws of wss.clients) ws.terminate();
      const closed = new Promise((resolve) => httpServer.close(resolve));
      await manager.close();
      return closed;
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
