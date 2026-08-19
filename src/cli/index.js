import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCollagentServer } from '../server/server.js';
import { CollagentClient, AgentHost } from '../client/client.js';
import {
  createAdapter, describeAdapter, adapterTypes, adapterFor, findRuntime,
  runtimeLabel, runtimeGlyph, isRuntimeInstalled, runtimesWithInstallState, RUNTIMES,
} from '../adapters/registry.js';
import { startTui, renderEvent, renderPresence, renderRoomList, ago } from '../ui/tui.js';
import { paint } from '../ui/colors.js';
import { printLogo, wordmark } from '../ui/brand.js';
import { pickRuntime, confirmDanger } from '../ui/picker.js';
import { buildRoomSummary } from '../core/room-summary.js';
import { defaultDataDir } from '../core/session-manager.js';
import { VERSION } from '../version.js';

export const DEFAULT_PORT = 7717;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'bin', 'collagent.js');

const USAGE = `
collagent — multiplayer sessions for AI coding agents

Usage:
  collagent create [options]       create a shared room + launch a coding agent
  collagent join <code> [options]  join a room from your machine (full history replays)
  collagent open <code> [options]  reopen a stored room as host + re-attach its agent
  collagent rooms                  list your rooms (live + stored) with participants
  collagent status <code>          show one room's state and participants
  collagent leave                  leave the last room you joined
  collagent delete <code>          delete a room and its history (asks first; --yes skips)
  collagent serve [options]        run a session server (rooms persist across restarts)

Options:
  --agent <runtime>      coding agent to use         (${RUNTIMES.filter((r) => r.status === 'available').map((r) => r.id).join(' | ')})
  --name <name>          your display name           (default: $USER)
  --server <url>         session server              (default: ws://127.0.0.1:${DEFAULT_PORT})
  --adapter <type>       exact adapter for create    (${adapterTypes().join(' | ')})
  --headless             use the feed UI instead of the agent's own native UI
  --cwd <dir>            working dir for the agent   (default: current dir)
  --model <model>        model override
  --permission-mode <m>  claude permission mode      (claude headless only; default: acceptEdits)
  --port <port>          port for serve              (default: ${DEFAULT_PORT})
  --host <host>          bind host for serve         (default: 0.0.0.0)

\`create\` asks which coding agent to use, then launches that agent's own
interactive UI untouched and adds the multiplayer layer around it: hooks stream
activity to participants, and remote instructions are typed visibly into the
agent's own prompt box. Pass --agent to skip the chooser.
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
    case 'delete':
    case 'rm': return cmdDelete(opts);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printLogo();
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
  const adapterType = await resolveAdapter(opts);
  if (!adapterType) return; // chooser cancelled

  console.log(`  ${paint.green('✓')} ${paint.bold(runtimeLabel(adapterType))}`);
  console.log('');
  console.log(paint.dim('  Creating your room…'));

  const name = opts.name ?? defaultName();
  const serverUrl = defaultServer(opts);
  await ensureServer(serverUrl);

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
    console.log(paint.yellow(`  Room ${code} already has a host — joining you as a collaborator instead.`));
    return enterRoomFeed({ client, welcome, name, code });
  }

  // a saved room already knows its agent; only re-ask if the caller overrides
  let adapterType = welcome.session?.agentType;
  if (opts.adapter || opts.agent || opts.runtime || !isKnownAdapter(adapterType)) {
    adapterType = await resolveAdapter(opts);
    if (!adapterType) return;
  } else {
    requireInstalled(findRuntime(describeAdapter(adapterType).runtime));
  }

  await hostRoom({
    client, code, serverUrl, opts,
    adapterType,
    verb: 'reopened',
    resumeId: welcome.agentSessionId ?? null,
  });
}

function isKnownAdapter(type) {
  try {
    describeAdapter(type);
    return true;
  } catch {
    return false;
  }
}

// --adapter wins, then --agent, then the chooser (null = cancelled).
// Non-TTY sessions never prompt: they get an installed headless adapter.
async function resolveAdapter(opts) {
  const headless = Boolean(opts.headless) || !process.stdout.isTTY;

  if (opts.adapter) {
    const descriptor = describeAdapter(opts.adapter); // throws with the valid list if unknown
    requireInstalled(findRuntime(descriptor.runtime));
    return opts.adapter;
  }

  const requested = opts.agent ?? opts.runtime;
  if (requested) {
    const runtime = findRuntime(requested);
    if (!runtime) {
      throw new Error(`unknown agent "${requested}" (available: ${RUNTIMES.map((r) => r.id).join(', ')})`);
    }
    if (runtime.status !== 'available') {
      throw new Error(`${runtime.label} support is not ready yet — ${runtime.note}`);
    }
    requireInstalled(runtime);
    return adapterFor(runtime.id, { headless });
  }

  const runtimes = runtimesWithInstallState();
  const installed = runtimes.filter((r) => r.status === 'available' && r.installed);
  if (!installed.length) return noAgentsInstalled(runtimes);

  if (headless) {
    const pick = installed.find((r) => r.id === DEFAULT_RUNTIME) ?? installed[0];
    return adapterFor(pick.id, { headless: true });
  }

  const runtime = await pickRuntime(runtimes);
  if (!runtime) {
    console.log(paint.dim('  cancelled — no room created'));
    return null;
  }
  return adapterFor(runtime.id, { headless });
}

function requireInstalled(runtime) {
  if (!runtime || isRuntimeInstalled(runtime)) return;
  throw new Error(
    `${runtime.label} is not installed on this machine (no "${runtime.bin}" on PATH).\n` +
    `Install it first:  ${runtime.install}`,
  );
}

function noAgentsInstalled(runtimes) {
  const width = Math.max(...runtimes.map((r) => r.label.length));
  console.log('');
  console.log(`  ${paint.bold('No coding agents found on this machine.')}`);
  console.log(paint.dim('  Hosting a room runs a real agent locally — install one of these first:'));
  console.log('');
  for (const r of runtimes.filter((x) => x.status === 'available')) {
    console.log(`    ${paint.ink(r.glyph ?? '●')}  ${r.label.padEnd(width)}  ${paint.dim(r.install)}`);
  }
  console.log('');
  console.log(paint.dim('  Joining someone else\'s room needs no agent at all: ') + paint.bold('collagent join <code>'));
  console.log('');
  return null;
}

const DEFAULT_RUNTIME = 'claude';

const withAgentLabels = (rooms) =>
  rooms.map((room) => ({ ...room, agentLabel: runtimeLabel(room.agentType) }));

async function cmdRooms(opts) {
  const serverUrl = defaultServer(opts);
  if (isLocalHost(serverUrl)) await ensureServer(serverUrl).catch(() => {});
  const { rooms, offline } = await listRooms(serverUrl);

  // rooms with people first, then newest
  const liveliness = (r) => ((r.participants ?? []).some((p) => p.connected) ? 1 : 0);
  rooms.sort((a, b) => liveliness(b) - liveliness(a) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

  const notes = [];
  if (offline) notes.push(paint.yellow('saved rooms on this machine'));
  else if (!isLocalHost(serverUrl)) notes.push(paint.dim(`via ${new URL(serverUrl.replace(/^ws/, 'http')).host}`));

  console.log('');
  console.log(`  ${wordmark()} ${paint.dim('·')} ${rooms.length} ${rooms.length === 1 ? 'room' : 'rooms'}${notes.length ? ` ${paint.dim('·')} ${notes.join(' ')}` : ''}`);
  console.log('');
  if (!rooms.length) {
    console.log(paint.dim('  No rooms yet — start one with: ') + paint.bold('collagent create'));
    console.log('');
    return;
  }
  console.log(renderRoomList(withAgentLabels(rooms), { homedir: os.homedir() }));
  console.log(paint.dim('  collagent join <code> — jump in · collagent open <code> — reopen · collagent delete <code> — remove'));
  console.log('');
}

async function printRecentRooms(opts) {
  try {
    const { rooms } = await listRooms(defaultServer(opts));
    if (!rooms.length) return;
    console.log(paint.bold('Recent rooms'));
    console.log('');
    console.log(renderRoomList(withAgentLabels(rooms.slice(0, 3)), { homedir: os.homedir(), header: false }));
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
  const label = runtimeLabel(adapterType);
  const mark = runtimeGlyph(adapterType);
  const banner = () => {
    console.log('');
    console.log(`  ${paint.green('✓')} ${paint.bold(`Room ${verb}`)}  ${paint.bold(code)} ${paint.dim('·')} ${mark ? `${mark} ` : ''}${label}`);
    console.log('');
    console.log(`    ${paint.dim('Invite your team')}   ${paint.bold(`collagent join ${code}`)}${isRemoteable(serverUrl) ? ` ${paint.dim(`--server ${serverUrl}`)}` : ''}`);
    console.log(`    ${paint.dim('Watch in browser')}   ${paint.dim(webUrl(serverUrl, code))}`);
    if (resumeId) {
      console.log(`    ${paint.dim('Resuming')}           ${paint.dim(`${label} conversation ${resumeId.slice(0, 8)}… continues where it left off`)}`);
    }
    console.log('');
  };

  const descriptor = describeAdapter(adapterType);
  const adapter = createAdapter(adapterType, {
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    model: opts.model,
    permissionMode: opts.permissionMode,
    statusUrl: `${httpUrl(serverUrl)}/api/sessions/${code}`,
    sessionCode: code,
    ...(resumeId ? descriptor.resumeOptions(resumeId) : {}),
    onExit: async () => {
      console.log('');
      console.log(paint.dim(`${label} closed — room ${code} is saved. Pick it back up anytime: `) + paint.bold(`collagent open ${code}`));
      try { client.leave(); } catch { /* server may be gone */ }
      setTimeout(() => process.exit(0), 300);
    },
  });
  const host = new AgentHost({ serverUrl, code, agentToken: client.agentToken, adapter });

  if (descriptor.ownsTerminal) {
    banner();
    console.log(paint.dim(`  Opening your normal ${label} — teammates' instructions appear right in its prompt box.`));
    if (descriptor.runtime === 'claude') {
      console.log(paint.dim('  Your room code and who\'s here stay visible in its status line.'));
    } else {
      console.log(paint.dim('  See who\'s here anytime with: collagent rooms'));
    }
    console.log('');
    await host.start(); // the PTY takes over this terminal; onExit handles shutdown
    return;
  }

  await host.start();
  banner();
  console.log(renderPresence(client.session, client.self.participantId, { agentLabel: label }));
  console.log('');
  console.log(paint.dim(`  Type to instruct ${label} · /help for commands`));
  console.log('');

  startTui({
    client,
    agentLabel: label,
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

// Status churn and title changes are metadata, not conversation — skip in replay.
const REPLAY_SKIP = new Set(['agent_status', 'session_title']);

function enterRoomFeed({ client, welcome, name, code }) {
  const agentType = welcome.session?.agentType ?? client.session?.agentType;
  const agentLabel = runtimeLabel(agentType);
  const mark = runtimeGlyph(agentType);
  const online = client.session.participants.filter((p) => p.connected).length;
  const topic = buildRoomSummary(welcome.events).title;
  console.log('');
  console.log(`  ${paint.green('✓')} ${paint.bold("You're in")} ${paint.dim('·')} room ${paint.bold(code)} ${paint.dim('·')} ${mark ? `${mark} ` : ''}${agentLabel} ${paint.dim('·')} ${online} ${online === 1 ? 'person' : 'people'} here`);
  if (topic) console.log(`    ${paint.dim('Topic:')} ${paint.bold(topic)}`);
  if (client.name !== name) {
    console.log(paint.yellow(`    heads-up: "${name}" was taken, so you're "${client.name}" here (--name picks another)`));
  }
  console.log('');
  console.log(renderPresence(client.session, client.self.participantId, { agentLabel }));
  console.log('');

  const history = welcome.events.filter((e) => !REPLAY_SKIP.has(e.kind));
  if (history.length) {
    console.log(paint.dim(`— catching you up · ${history.length} events —`));
    for (const event of history) {
      const line = renderEvent(event, { selfId: client.self.participantId, agentLabel });
      if (line) console.log(line);
    }
    console.log(paint.dim("— you're all caught up —"));
    console.log('');
  }
  console.log(paint.dim(`  Type to instruct ${agentLabel} · /help for commands`));
  console.log('');

  startTui({
    client,
    agentLabel,
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
  console.log(renderRoomList(withAgentLabels([s]), { homedir: os.homedir() }));
  console.log(renderPresence(s, null, { agentLabel: runtimeLabel(s.agentType) }));
  console.log(paint.dim(`  ${s.mode} mode · created ${ago(s.createdAt)} · invite: collagent join ${s.code}`));
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
    console.log(`Left room ${state.code}.`);
  } catch {
    console.log(`Couldn't reach the server — cleared your local state for room ${state.code}.`);
  }
  clearState();
}

async function cmdDelete(opts) {
  const code = (opts._[0] ?? '').toUpperCase();
  if (!code) {
    console.error('usage: collagent delete <code> [--yes]');
    process.exitCode = 1;
    return;
  }
  const serverUrl = defaultServer(opts);
  if (isLocalHost(serverUrl)) await ensureServer(serverUrl).catch(() => {});
  const online = Boolean(await serverHealth(serverUrl));

  const room = await findRoom(code, serverUrl, online);
  if (!room) {
    console.error(`No room ${code}.`);
    process.exitCode = 1;
    return;
  }

  if (!opts.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`refusing to delete room ${code} without confirmation — rerun with --yes`);
      process.exitCode = 1;
      return;
    }
    const peopleIn = (room.participants ?? []).some((p) => p.connected);
    console.log('');
    const sure = await confirmDanger({
      title: `Delete room ${code} · ${runtimeLabel(room.agentType)}${room.title ? ` · “${room.title}”` : ''}?`,
      detail: peopleIn
        ? 'People are in this room right now — it ends for everyone, and its history is erased.'
        : 'Its history will be erased. This cannot be undone.',
    });
    if (!sure) return console.log(paint.dim(`  Cancelled — room ${code} kept.`));
  }

  if (online) {
    const res = await fetch(`${httpUrl(serverUrl)}/api/sessions/${code}`, { method: 'DELETE' });
    if (res.ok) return console.log(`Room ${code} deleted.`);
  } else {
    try {
      fs.unlinkSync(path.join(defaultDataDir(), 'history', `${code}.jsonl`));
      return console.log(`Room ${code} deleted.`);
    } catch { /* fall through */ }
  }
  console.error(`Could not delete room ${code}.`);
  process.exitCode = 1;
}

// A room's summary from the live server, or from its history file when offline.
async function findRoom(code, serverUrl, online) {
  if (online) {
    try {
      const res = await fetch(`${httpUrl(serverUrl)}/api/sessions/${code}`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch { /* fall through to disk */ }
  }
  try {
    const events = fs.readFileSync(path.join(defaultDataDir(), 'history', `${code}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    return { code, ...buildRoomSummary(events) };
  } catch {
    return null;
  }
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

function webUrl(serverUrl, code) {
  return `${httpUrl(serverUrl).replace('://127.0.0.1', '://localhost')}/?code=${code}`;
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

// Auto-start a local server, and auto-restart an outdated one — rooms
// restore from disk on boot, so a restart loses nothing.
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
