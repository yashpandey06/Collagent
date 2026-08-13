import readline from 'node:readline';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const paint = {
  dim: (s) => c('2', s),
  bold: (s) => c('1', s),
  green: (s) => c('32', s),
  yellow: (s) => c('33', s),
  blue: (s) => c('34', s),
  magenta: (s) => c('35', s),
  cyan: (s) => c('36', s),
  red: (s) => c('31', s),
};

export function renderEvent(event, { selfId } = {}) {
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
      // Typed directly into the host's Claude Code terminal (seen via hooks)
      return `${paint.bold(paint.blue('⌨ host terminal ›'))} ${data.text}`;
    case 'notice':
      return paint.yellow(`🔔 claude code: ${data.message}`);
    case 'agent_message':
      return `${paint.magenta('⏺ claude')} ${data.text}`;
    case 'tool_use':
      return paint.yellow(`  ⚙ ${data.tool} ${paint.dim(truncate(data.input ?? '', 120))}`);
    case 'tool_result':
      return paint.dim(`    └ ${data.isError ? paint.red('error: ') : ''}${truncate(data.summary ?? '', 140)}`);
    case 'result': {
      const secs = data.durationMs ? ` in ${(data.durationMs / 1000).toFixed(1)}s` : '';
      const cost = data.costUsd ? ` ($${data.costUsd.toFixed(4)})` : '';
      return data.ok
        ? paint.green(`✓ turn complete${secs}${cost}`)
        : paint.red(`✗ turn failed${secs}`);
    }
    case 'agent_status': {
      const map = {
        starting: paint.dim('· claude code is starting…'),
        ready: paint.green(`· claude code ready ${paint.dim(data.detail?.model ?? '')}`),
        working: paint.dim('· claude code is working…'),
        idle: null, // covered by the result line
        exited: paint.red(`· claude code exited${data.detail?.code != null ? ` (code ${data.detail.code})` : ''}`),
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
    case 'error':
      return paint.red(`! ${data.message}`);
    default:
      return paint.dim(`[${kind}]`);
  }
}

export function renderPresence(session, selfId) {
  const people = session.participants
    .map((p) => {
      const marks = [];
      if (p.role === 'host') marks.push('host');
      if (p.id === session.driverId) marks.push('driver');
      const label = `${p.name}${p.id === selfId ? ' (you)' : ''}${marks.length ? ` [${marks.join(', ')}]` : ''}`;
      return p.connected ? paint.green(`● ${label}`) : paint.dim(`○ ${label}`);
    })
    .join('  ');
  const agentName = session.agentType ?? 'agent';
  const agent = session.status === 'waiting_agent'
    ? paint.dim(`○ ${agentName} (starting)`)
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

function roomState(room) {
  if (room.ended) return paint.dim('■ ended  ');
  if (room.offline) return paint.dim('○ stored ');
  const online = (room.participants ?? []).filter((p) => p.connected).length;
  switch (room.status) {
    case 'working': return paint.yellow('◐ working');
    case 'paused': return paint.yellow('⏸ paused ');
    case 'waiting_agent':
      return online ? paint.cyan('◌ no agent') : paint.dim('○ stored ');
    default: return paint.green(`● ${room.status.padEnd(7)}`);
  }
}

function roomPeople(room) {
  const online = (room.participants ?? []).filter((p) => p.connected);
  if (online.length) {
    return online
      .map((p) => paint.green(`●${p.name}${p.id === room.driverId ? '*' : ''}`))
      .join(' ');
  }
  const ever = room.participantsEver ?? [];
  return ever.length ? paint.dim(`was: ${ever.join(', ')}`) : paint.dim('empty');
}

/**
 * Room listing for `collagent rooms`:
 *
 *   ● ZADU8  idle      ●Alice* ●Bob              ~/dev/api
 *     └ Bob › add oauth validation…              2m ago · 47 events
 */
export function renderRoomList(rooms, { homedir = '', width = process.stdout.columns || 100 } = {}) {
  const lines = [];
  for (const room of rooms) {
    const head = [
      ` ${roomState(room)}`,
      paint.bold(room.code.padEnd(6)),
      roomPeople(room),
    ].join('  ');
    const dir = shortPath(room.cwd, homedir);
    lines.push(dir ? `${head}  ${paint.dim(dir)}` : head);

    const meta = `${ago(room.lastActivity)} · ${room.eventCount ?? 0} events`;
    if (room.lastInstruction?.text) {
      const speaker = `${room.lastInstruction.name} › `;
      const budget = Math.max(20, width - meta.length - speaker.length - 14);
      const text = room.lastInstruction.text.length > budget
        ? room.lastInstruction.text.slice(0, budget) + '…'
        : room.lastInstruction.text;
      lines.push(`     ${paint.dim('└')} ${paint.cyan(speaker)}${text}  ${paint.dim(meta)}`);
    } else {
      lines.push(`     ${paint.dim(`└ ${meta}`)}`);
    }
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
  anything else        sent as an instruction to the shared Claude Code agent
`;

/**
 * Interactive terminal loop shared by `collagent create` and `collagent join`.
 */
export function startTui({ client, onQuit }) {
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

  client.on('event', (event) => println(renderEvent(event, { selfId: client.self?.participantId })));
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
          println(renderPresence(client.session, client.self?.participantId));
          break;
        case 'status': {
          const s = client.session;
          println(paint.dim(`session ${s.code} · status=${s.status} · mode=${s.mode} · events=${s.eventCount}`));
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
