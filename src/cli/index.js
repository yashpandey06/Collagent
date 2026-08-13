import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCollagentServer } from '../server/server.js';
import { CollagentClient, AgentHost } from '../client/client.js';
import { createAdapter, adapterTypes } from '../adapters/index.js';
import { startTui, renderEvent, renderPresence, renderRoomList, ago, shortPath, paint } from '../client/tui.js';
import { buildRoomSummary } from '../core/room-summary.js';
import { defaultDataDir } from '../core/session-manager.js';
import { VERSION } from '../version.js';

export const DEFAULT_PORT = 7717;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'bin', 'collagent.js');

const USAGE = `
collagent — multiplayer sessions for AI agents (Claude Code MVP)

Usage:
  collagent create [options]       create a shared room + launch Claude Code
  collagent join <code> [options]  join a room from your machine (full history replays)
  collagent open <code> [options]  reopen a stored room as host + re-attach Claude Code
  collagent rooms                  list your rooms (live + stored) with participants
  collagent status <code>          show one room's state and participants
  collagent leave                  leave the last room you joined
  collagent serve [options]        run a session server (rooms persist across restarts)

Options:
  --name <name>          your display name           (default: $USER)
  --server <url>         session server              (default: ws://127.0.0.1:${DEFAULT_PORT})
  --adapter <type>       agent adapter for create    (${adapterTypes().join(' | ')})
  --headless             use headless claude + feed UI instead of the native Claude Code UI
  --cwd <dir>            working dir for the agent   (default: current dir)
  --model <model>        model override for claude
  --permission-mode <m>  claude permission mode      (headless mode only; default: acceptEdits)
  --port <port>          port for serve              (default: ${DEFAULT_PORT})
  --host <host>          bind host for serve         (default: 0.0.0.0)

By default \`create\` launches your normal interactive Claude Code (untouched UI)
and adds the multiplayer layer around it: hooks stream activity to participants,
and remote instructions are typed visibly into Claude Code's own prompt box.
`;

export async function run(argv) {
  const [command, ...rest] = argv;
  const opts = parseFlags(rest);

  switch (command) {
    case 'serve': return cmdServe(opts);
    case 'create': return cmdCreate(opts);
    case 'open': return cmdOpen(opts);
    case 'rooms':
    case 'ls': return cmdRooms(opts);
    case 'join': return cmdJoin(opts);
    case 'status': return cmdStatus(opts);
    case 'leave': return cmdLeave(opts);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      await printRecentRooms(opts);
      return;
    default:
      console.error(`unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

function parseFlags(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

const defaultName = () => process.env.COLLAGENT_NAME || os.userInfo().username;
const defaultServer = (opts) => opts.server || process.env.COLLAGENT_SERVER || `ws://127.0.0.1:${DEFAULT_PORT}`;

// ---- commands ------------------------------------------------------------

async function cmdServe(opts) {
  const port = Number(opts.port ?? DEFAULT_PORT);
  const host = opts.host ?? '0.0.0.0';
  const server = createCollagentServer({
    dataDir: defaultDataDir(),
    log: (...a) => console.log(paint.dim('[server]'), ...a),
  });
  const addr = await server.listen(port, host);
  try {
    fs.mkdirSync(defaultDataDir(), { recursive: true });
    fs.writeFileSync(
      path.join(defaultDataDir(), 'server.json'),
      JSON.stringify({ pid: process.pid, port: addr.port, version: VERSION }),
    );
  } catch { /* non-fatal */ }
  console.log(`collagent server v${VERSION} listening on http://${host}:${addr.port}  (ws path: /ws)`);
  console.log(paint.dim(`rooms & history: ${path.join(defaultDataDir(), 'history')}`));
}

async function cmdCreate(opts) {
  const name = opts.name ?? defaultName();
  const serverUrl = defaultServer(opts);
  await ensureServer(serverUrl);

  const adapterType = pickAdapter(opts);
  const client = new CollagentClient({ serverUrl, name });
  await client.connect();
  const created = await client.createSession({ agentType: adapterType });
  saveState({ serverUrl, code: created.session.code, self: client.self, name });

  await hostRoom({ client, code: created.session.code, serverUrl, opts, adapterType, verb: 'created' });
}

async function cmdOpen(opts) {
  const code = (opts._[0] ?? '').toUpperCase();
  if (!code) {
    console.error('usage: collagent open <code>');
    process.exitCode = 1;
    return;
  }
  const name = opts.name ?? defaultName();
  const serverUrl = defaultServer(opts);
  await ensureServer(serverUrl);

  const client = new CollagentClient({ serverUrl, name });
  await client.connect();
  const welcome = await client.join(code);
  saveState({ serverUrl, code, self: client.self, name });

  if (!client.agentToken) {
    console.log(paint.yellow(`room ${code} already has a host — joining as a collaborator instead`));
    return enterRoomFeed({ client, welcome, name, code });
  }

  const resumeId = welcome.agentSessionId ?? null;
  await hostRoom({
    client, code, serverUrl, opts,
    adapterType: pickAdapter(opts),
    verb: 'reopened',
    resumeId,
  });
}

const pickAdapter = (opts) =>
  opts.adapter ?? (opts.headless || !process.stdout.isTTY ? 'claude-code' : 'claude-native');

async function cmdRooms(opts) {
  const serverUrl = defaultServer(opts);
  if (isLocalHost(serverUrl)) await ensureServer(serverUrl).catch(() => {});
  const { rooms, offline } = await listRooms(serverUrl);

  console.log('');
  const source = offline
    ? paint.yellow('server offline — showing stored rooms from disk')
    : paint.dim(`server ${serverUrl}`);
  console.log(` ${paint.bold('collagent rooms')}  ${paint.dim('·')}  ${rooms.length} room${rooms.length === 1 ? '' : 's'}  ${paint.dim('·')}  ${source}`);
  console.log('');
  if (!rooms.length) {
    console.log(paint.dim('  no rooms yet — start one with: collagent create'));
    console.log('');
    return;
  }
  console.log(renderRoomList(rooms, { homedir: os.homedir() }));
  console.log(paint.dim(`  join: collagent join <code> · reopen: collagent open <code> · end for everyone: /end in-session`));
  console.log('');
}

async function printRecentRooms(opts) {
  try {
    const { rooms } = await listRooms(defaultServer(opts));
    if (!rooms.length) return;
    console.log(paint.bold('Recent rooms:'));
    console.log('');
    console.log(renderRoomList(rooms.slice(0, 3), { homedir: os.homedir() }));
    if (rooms.length > 3) console.log(paint.dim(`  …and ${rooms.length - 3} more — collagent rooms`));
    console.log('');
  } catch { /* listing is a bonus, never an error */ }
}

/** Rooms from the live server, or read from history files when it's down. */
async function listRooms(serverUrl) {
  const health = await serverHealth(serverUrl);
  if (health) {
    const res = await fetch(`${httpUrl(serverUrl)}/api/sessions`, { signal: AbortSignal.timeout(2000) });
    const rooms = (await res.json()).filter((r) => !r.ended);
    return { rooms, offline: false };
  }

  const dir = path.join(defaultDataDir(), 'history');
  const rooms = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch { /* no history yet */ }
  for (const file of files) {
    try {
      const events = fs.readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const summary = buildRoomSummary(events);
      if (summary.ended) continue;
      rooms.push({ code: path.basename(file, '.jsonl').toUpperCase(), ...summary, offline: true });
    } catch { /* skip unreadable room files */ }
  }
  rooms.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return { rooms, offline: true };
}

async function hostRoom({ client, code, serverUrl, opts, adapterType, verb, resumeId = null }) {
  const banner = () => {
    console.log('');
    console.log(paint.green(`✓ Shared room ${verb}`));
    console.log(`  Room:    ${paint.bold(code)}`);
    console.log(`  Invite:  ${paint.bold(`collagent join ${code}`)}${isRemoteable(serverUrl) ? paint.dim(` --server ${serverUrl}`) : ''}`);
    console.log(paint.dim(`  Web:     ${httpUrl(serverUrl)}/?code=${code}`));
    if (resumeId) console.log(paint.dim(`  Resume:  continuing claude code conversation ${resumeId.slice(0, 8)}…`));
  };

  const adapter = createAdapter(adapterType, {
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    model: opts.model,
    permissionMode: opts.permissionMode,
    statusUrl: `${httpUrl(serverUrl)}/api/sessions/${code}`,
    sessionCode: code,
    ...(resumeId && adapterType === 'claude-native' && { extraArgs: ['--resume', resumeId] }),
    ...(resumeId && adapterType === 'claude-code' && { sessionId: resumeId, resume: true }),
    onExit: async () => {
      console.log('');
      console.log(paint.dim(`claude code exited — room ${code} stays stored (reopen: collagent open ${code})`));
      try { client.leave(); } catch { /* server may be gone */ }
      setTimeout(() => process.exit(0), 300);
    },
  });
  const host = new AgentHost({ serverUrl, code, agentToken: client.agentToken, adapter });

  if (adapterType === 'claude-native') {
    banner();
    console.log(paint.dim('  Launching your normal Claude Code — remote instructions will appear in its prompt box.'));
    console.log('');
    await host.start(); // PTY takes over this terminal with the untouched Claude Code UI
    return; // process stays alive via the PTY; onExit handles shutdown
  }

  await host.start();
  banner();
  console.log(paint.dim(`  Agent:   ${adapterType} in ${adapter.info.cwd ?? process.cwd()}`));
  console.log('');
  console.log(renderPresence(client.session, client.self.participantId));
  console.log(paint.dim('type an instruction, or /help for commands'));
  console.log('');

  startTui({
    client,
    onQuit: async () => {
      await host.stop();
      client.close();
      process.exit(0);
    },
  });
}

async function cmdJoin(opts) {
  const code = (opts._[0] ?? '').toUpperCase();
  if (!code) {
    console.error('usage: collagent join <code>');
    process.exitCode = 1;
    return;
  }
  const name = opts.name ?? defaultName();
  const serverUrl = defaultServer(opts);

  const client = new CollagentClient({ serverUrl, name });
  await client.connect();
  const welcome = await client.join(code);
  saveState({ serverUrl, code, self: client.self, name });
  enterRoomFeed({ client, welcome, name, code });
}

// Status churn (working/idle flips) is noise in a replay; everything a human
// said or the agent did stays.
const REPLAY_SKIP = new Set(['agent_status']);

function enterRoomFeed({ client, welcome, name, code }) {
  console.log('');
  console.log(paint.green('✓ Joined shared room ') + paint.bold(code));
  if (client.name !== name) {
    console.log(paint.yellow(`  the name "${name}" was taken — you are "${client.name}" here (use --name to pick your own)`));
  }
  console.log('');
  console.log(renderPresence(client.session, client.self.participantId));
  console.log('');

  const history = welcome.events.filter((e) => !REPLAY_SKIP.has(e.kind));
  if (history.length) {
    console.log(paint.dim(`— room history (${history.length} events) —`));
    for (const event of history) {
      const line = renderEvent(event, { selfId: client.self.participantId });
      if (line) console.log(line);
    }
    console.log(paint.dim('— you are caught up —'));
  }
  console.log(paint.dim('type an instruction, or /help for commands'));
  console.log('');

  startTui({
    client,
    onQuit: () => {
      client.close();
      process.exit(0);
    },
  });
}

async function cmdStatus(opts) {
  const code = (opts._[0] ?? loadState()?.code ?? '').toUpperCase();
  if (!code) {
    console.error('usage: collagent status <code>');
    process.exitCode = 1;
    return;
  }
  const base = httpUrl(defaultServer(opts));
  const res = await fetch(`${base}/api/sessions/${code}`);
  if (!res.ok) {
    console.error(`no session ${code} on ${base}`);
    process.exitCode = 1;
    return;
  }
  const s = await res.json();
  console.log('');
  console.log(renderRoomList([s], { homedir: os.homedir() }));
  console.log(renderPresence(s, null));
  console.log(paint.dim(`  mode ${s.mode} · created ${ago(s.createdAt)}${s.cwd ? ` · ${shortPath(s.cwd, os.homedir())}` : ''}`));
  console.log('');
}

async function cmdLeave(opts) {
  const state = loadState();
  if (!state) {
    console.log('not in a session');
    return;
  }
  try {
    const client = new CollagentClient({ serverUrl: opts.server ?? state.serverUrl, name: state.name });
    await client.connect();
    client._send({
      type: 'rejoin',
      code: state.code,
      participantId: state.self.participantId,
      resumeToken: state.self.resumeToken,
      sinceSeq: 1e9,
    });
    await client._await('reconnected').catch(() => {});
    client.leave();
    client.close();
    console.log(`left session ${state.code}`);
  } catch {
    console.log(`could not reach server; cleared local session state for ${state.code}`);
  }
  clearState();
}

// ---- local state & server bootstrap ---------------------------------------

function stateFile() {
  return path.join(defaultDataDir(), 'state.json');
}

function saveState(state) {
  try {
    fs.mkdirSync(defaultDataDir(), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}

function clearState() {
  try { fs.unlinkSync(stateFile()); } catch { /* ignore */ }
}

function httpUrl(wsUrl) {
  const u = new URL(wsUrl.replace(/^ws/, 'http'));
  return `http://${u.hostname}:${u.port || DEFAULT_PORT}`;
}

function isRemoteable(serverUrl) {
  const { hostname } = new URL(serverUrl.replace(/^ws/, 'http'));
  return !['127.0.0.1', 'localhost', '::1'].includes(hostname);
}

async function serverHealth(serverUrl) {
  try {
    const res = await fetch(`${httpUrl(serverUrl)}/healthz`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const isLocalHost = (serverUrl) =>
  ['127.0.0.1', 'localhost', '::1'].includes(new URL(serverUrl.replace(/^ws/, 'http')).hostname);

/**
 * Auto-start a local server when none is running, and auto-restart a local
 * server left behind by an older collagent version (its rooms restore from
 * disk on boot, so a restart loses nothing).
 */
async function ensureServer(serverUrl) {
  const health = await serverHealth(serverUrl);
  if (health?.version === VERSION) return;

  if (health && !isLocalHost(serverUrl)) {
    console.log(paint.yellow(`warning: server ${serverUrl} runs v${health.version ?? '<0.1.0'}, CLI is v${VERSION}`));
    return;
  }
  if (health && isLocalHost(serverUrl)) {
    console.log(paint.dim(`restarting local session server (v${health.version ?? '<0.1.0'} → v${VERSION})…`));
    if (!(await stopLocalServer(serverUrl))) {
      throw new Error(
        `a stale collagent server is running on ${serverUrl} and could not be stopped — ` +
        `kill it manually (lsof -ti tcp:${new URL(serverUrl.replace(/^ws/, 'http')).port || DEFAULT_PORT} | xargs kill) and retry`,
      );
    }
  }
  if (!isLocalHost(serverUrl)) {
    throw new Error(`session server ${serverUrl} is not reachable`);
  }

  const { port } = new URL(serverUrl.replace(/^ws/, 'http'));
  console.log(paint.dim(`starting local session server on port ${port || DEFAULT_PORT}…`));
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port || DEFAULT_PORT)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    if ((await serverHealth(serverUrl))?.version === VERSION) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('local session server failed to start');
}

async function stopLocalServer(serverUrl) {
  const wantPort = Number(new URL(serverUrl.replace(/^ws/, 'http')).port || DEFAULT_PORT);
  try {
    const info = JSON.parse(fs.readFileSync(path.join(defaultDataDir(), 'server.json'), 'utf8'));
    if (info.port === wantPort && info.pid) process.kill(info.pid, 'SIGTERM');
  } catch {
    // pre-0.1.x servers wrote no server.json; fall back to the port owner
    try {
      const { execSync } = await import('node:child_process');
      execSync(`lsof -ti tcp:${wantPort} -sTCP:LISTEN | xargs kill`, { stdio: 'ignore' });
    } catch { /* handled below */ }
  }
  for (let i = 0; i < 20; i++) {
    if (!(await serverHealth(serverUrl))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
