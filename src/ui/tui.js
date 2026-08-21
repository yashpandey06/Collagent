import readline from 'node:readline';
import { paint } from './colors.js';

export function renderEvent(event, { selfId, agentLabel = 'agent' } = {}) {
  const { kind, actor = {}, data = {} } = event;
  const who = actor.name ?? 'unknown';
  const isSelf = actor.id && actor.id === selfId;
  const name = isSelf ? `${who} (you)` : who;

  switch (kind) {
    case 'session_created':
      return paint.dim(`— session ${data.code} created —`);
    case 'participant_joined':
      return paint.green(`● ${name} joined${data.role === 'host' ? ' (host)' : ''}`);
    case 'participant_left':
      return paint.dim(`○ ${name} left`);
    case 'participant_disconnected':
      return paint.dim(`○ ${name} disconnected`);
    case 'participant_reconnected':
      return paint.green(`● ${name} reconnected`);
    case 'instruction':
      return `${paint.bold(paint.cyan(`${name} ›`))} ${data.text}`;
    case 'local_prompt':
      return `${paint.bold(paint.blue('⌨ host terminal ›'))} ${data.text}`;
    case 'notice':
      return paint.yellow(`🔔 ${agentLabel}: ${data.message}`);
    case 'agent_message': {
      const text = String(data.text ?? '').trim().split('\n').join('\n  ');
      return `${paint.magenta(`⏺ ${agentLabel}`)} ${text}`;
    }
    case 'tool_use':
      return `${paint.yellow(`  ⚙ ${data.tool}`)} ${paint.dim(toolInputSummary(data.input))}`;
    case 'tool_result':
      return paint.dim(`    └ ${data.isError ? paint.red('error: ') : ''}${truncate(data.summary ?? '', 140)}`);
    case 'result': {
      const secs = data.durationMs ? ` in ${(data.durationMs / 1000).toFixed(1)}s` : '';
      const cost = data.costUsd ? ` ($${data.costUsd.toFixed(4)})` : '';
      // trailing blank line separates turns in the feed
      return (data.ok
        ? paint.green(`✓ turn complete${secs}${cost}`)
        : paint.red(`✗ turn failed${secs}`)) + '\n';
    }
    case 'agent_status': {
      const map = {
        starting: paint.dim(`· ${agentLabel} is starting…`),
        ready: paint.green(`· ${agentLabel} ready ${paint.dim(data.detail?.model ?? '')}`),
        working: paint.dim(`· ${agentLabel} is working…`),
        idle: null, // covered by the result line
        exited: paint.red(`· ${agentLabel} exited${data.detail?.code != null ? ` (code ${data.detail.code})` : ''}`),
        disconnected: paint.red('· agent disconnected'),
        error: paint.red(`· agent error: ${data.detail?.message ?? ''}`),
      };
      return map[data.status] ?? null;
    }
    case 'session_paused':
      return paint.yellow(`⏸ session paused by ${name}`);
    case 'session_resumed':
      return paint.green(`▶ session resumed by ${name}`);
    case 'control_transferred':
      return paint.cyan(`⇄ control handed to ${data.to?.name}`);
    case 'mode_changed':
      return paint.cyan(`⚑ mode set to ${data.mode} by ${name}`);
    case 'session_ended':
      return paint.red(`■ session ended by ${name}`);
    case 'session_title':
      return null; // room metadata, not feed content
    case 'error':
      return paint.red(`! ${data.message}`);
    default:
      return paint.dim(`[${kind}]`);
  }
}

export function renderPresence(session, selfId, { agentLabel } = {}) {
  const people = session.participants
    .map((p) => {
      const marks = [];
      if (p.role === 'host') marks.push('host');
      if (p.id === session.driverId) marks.push('driver');
      const label = `${p.name}${p.id === selfId ? ' (you)' : ''}${marks.length ? ` [${marks.join(', ')}]` : ''}`;
      return p.connected ? paint.green(`● ${label}`) : paint.dim(`○ ${label}`);
    })
    .join('  ');
  const agentName = agentLabel ?? session.agentType ?? 'agent';
  const agent = session.status === 'waiting_agent'
    ? paint.dim(`○ ${agentName} starting…`)
    : paint.magenta(`● ${agentName} [${session.status}${session.mode === 'driver' ? ', driver mode' : ''}]`);
  return `${people}  ${agent}`;
}

export function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function shortPath(p, homedir) {
  if (!p) return '';
  return homedir && p.startsWith(homedir) ? '~' + p.slice(homedir.length) : p;
}

const isLive = (room) => (room.participants ?? []).some((p) => p.connected);

// "alice* bob +1" (connected) or "was alice +2" (past roster); '' when empty.
export function roomPeopleText(room) {
  const online = (room.participants ?? []).filter((p) => p.connected);
  if (online.length) {
    const names = online.slice(0, 2)
      .map((p) => `${p.name}${p.id === room.driverId ? '*' : ''}`)
      .join(' ');
    return `${names}${online.length > 2 ? ` +${online.length - 2}` : ''}`;
  }
  const ever = room.participantsEver ?? [];
  if (!ever.length) return '';
  return `was ${ever[0]}${ever.length > 1 ? ` +${ever.length - 1}` : ''}`;
}

function roomPeople(room) {
  const text = roomPeopleText(room);
  if (!text) return null;
  return isLive(room) ? paint.green(`● ${text}`) : text;
}

const folderName = (cwd) => {
  const base = String(cwd ?? '').split('/').filter(Boolean).at(-1);
  return base ? truncate(base, 24) + '/' : null;
};

/**
 * Room listing for `collagent rooms`. Everything hugs the left edge — no
 * columns, no right-aligned meta — so nothing floats on wide terminals:
 *
 *   ● WTEYA  “Add OAuth callback validation”
 *            ✳ Claude Code · ● Alice* Bob · api/ · 2m ago
 */
export function renderRoomList(rooms, {
  width = process.stdout.columns || 100,
  header = true,
} = {}) {
  if (!rooms.length) return '';
  const W = Math.max(56, Math.min(width - 2, 92));
  const dot = paint.dim(' · ');

  const lines = [];
  let group = null;

  for (const room of rooms) {
    const live = isLive(room);
    if (header) {
      const g = live ? 'live' : 'saved';
      if (g !== group) {
        group = g;
        lines.push(live
          ? ` ${paint.green('▍')} ${paint.green(paint.bold('LIVE'))}`
          : ` ${paint.dim('▍')} ${paint.dim('SAVED')}`);
        lines.push('');
      }
    }

    // Line 1 — identity: the code as a solid chip (coral = live, gray = saved),
    // then the topic. The chip is the display type of the screen.
    const chip = live ? paint.chip(room.code.padEnd(5)) : paint.chipDim(room.code.padEnd(5));
    const title = room.title ? `“${truncate(room.title, W - 14)}”` : paint.dim('(no topic)');
    lines.push(` ${chip}  ${live && room.title ? paint.bold(title) : title}`);

    // Line 2 — one dim run of facts, hanging under the topic.
    const agent = `${room.agentGlyph ? `${room.agentGlyph} ` : ''}${room.agentLabel ?? 'agent'}`;
    const parts = [live ? agent : paint.dim(agent)];
    if (room.status === 'working') parts.push(paint.yellow('working…'));
    if (room.status === 'paused') parts.push(paint.yellow('paused'));
    const people = roomPeople(room);
    if (people) parts.push(live ? people : paint.dim(people));
    const folder = folderName(room.cwd);
    if (folder) parts.push(paint.dim(folder));
    parts.push(paint.dim(ago(room.lastActivity)));
    lines.push(`          ${parts.join(dot)}`);
    lines.push('');
  }
  return lines.join('\n');
}

const HELP = `
  /participants        show who is in the session
  /status              show session state
  /pause               pause the shared agent (host/driver)
  /resume              resume it
  /handoff <name>      hand control to another participant
  /mode open|driver    open: anyone can instruct; driver: only the driver
  /end                 end the session for everyone (host)
  /quit                leave the session
  anything else        sent as an instruction to the shared agent
`;

/** Interactive terminal loop shared by create and join. */
export function startTui({ client, onQuit, agentLabel = 'agent' }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: paint.bold('› '),
  });

  const println = (line) => {
    if (line == null) return;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    console.log(line);
    rl.prompt(true);
  };

  client.on('event', (event) => {
    // your own instruction echoes back from the server — the prompt line
    // you just typed is already on screen, so don't print it twice
    if (event.kind === 'instruction' && event.actor?.id === client.self?.participantId) return;
    println(renderEvent(event, { selfId: client.self?.participantId, agentLabel }));
  });
  client.on('session', () => {}); // presence shown on demand via /participants
  client.on('server-error', (message) => println(paint.red(`! ${message}`)));
  client.on('disconnected', () => println(paint.red('· connection lost — reconnecting…')));
  client.on('reconnected', () => println(paint.green('· reconnected')));
  client.on('closed', () => {
    println(paint.dim('· connection closed'));
  });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case 'help': println(HELP); break;
        case 'participants':
          println(renderPresence(client.session, client.self?.participantId, { agentLabel }));
          break;
        case 'status': {
          const s = client.session;
          const online = s.participants.filter((p) => p.connected).length;
          println(paint.dim(`room ${s.code} · ${agentLabel} · ${s.status} · ${s.mode} mode · ${online} ${online === 1 ? 'person' : 'people'} here · ${s.eventCount} events`));
          break;
        }
        case 'pause': client.control('pause'); break;
        case 'resume': client.control('resume'); break;
        case 'handoff': client.control('handoff', { target: rest.join(' ') }); break;
        case 'mode': client.control('set_mode', { mode: rest[0] }); break;
        case 'end': client.control('end'); break;
        case 'quit':
        case 'exit':
          client.leave();
          rl.close();
          onQuit?.();
          return;
        default:
          println(paint.red(`unknown command /${cmd} — try /help`));
      }
      return rl.prompt();
    }

    client.sendInstruction(text);
    rl.prompt();
  });

  rl.on('SIGINT', () => {
    client.leave();
    rl.close();
    onQuit?.();
  });

  rl.prompt();
  return rl;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Adapters send tool input as JSON; humans want the one argument that matters.
const TELLING_KEYS = ['command', 'file_path', 'absolute_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt'];

function toolInputSummary(input) {
  if (input == null || input === '') return '';
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch { return truncate(input, 110); }
  }
  if (typeof obj !== 'object' || obj === null) return truncate(String(obj), 110);
  for (const key of TELLING_KEYS) {
    if (typeof obj[key] === 'string' && obj[key].trim()) return truncate(obj[key].replace(/\s+/g, ' '), 110);
  }
  try { return truncate(JSON.stringify(obj), 110); } catch { return ''; }
}
