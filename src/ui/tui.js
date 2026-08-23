import readline from 'node:readline';
import { paint } from './colors.js';

export function renderEvent(event, { selfId, agentLabel = 'agent', multiAgent = false } = {}) {
  const { kind, actor = {}, data = {} } = event;
  const who = actor.name ?? 'unknown';
  const isSelf = actor.id && actor.id === selfId;
  const name = isSelf ? `${who} (you)` : who;
  // In a one-agent room the agent keeps its brand name; once several agents
  // share the room, lines carry the stable room-local id (claude-1, codex-1).
  const agentName = multiAgent ? event.agentId ?? agentLabel : agentLabel;

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
    case 'instruction': {
      const target = multiAgent && event.agentId ? paint.dim(` → ${event.agentId}`) : '';
      return `${paint.bold(paint.cyan(`${name} ›`))}${target} ${data.text}`;
    }
    case 'local_prompt':
      return `${paint.bold(paint.blue('⌨ host terminal ›'))} ${data.text}`;
    case 'notice':
      return paint.yellow(`🔔 ${data.message}`);
    case 'agent_message': {
      const text = String(data.text ?? '').trim().split('\n').join('\n  ');
      return `${paint.magenta(`⏺ ${agentName}`)} ${text}`;
    }
    case 'tool_use':
      return `${paint.yellow(`  ⚙ ${data.tool}`)} ${paint.dim(toolInputSummary(data.input))}`;
    case 'tool_result':
      // stored payloads are complete; the feed shows a one-line summary
      return paint.dim(`    └ ${data.isError ? paint.red('error: ') : ''}${truncate(String(data.summary ?? '').replace(/\s+/g, ' '), 140)}`);
    case 'result': {
      const secs = data.durationMs ? ` in ${(data.durationMs / 1000).toFixed(1)}s` : '';
      const cost = data.costUsd ? ` ($${data.costUsd.toFixed(4)})` : '';
      const tag = multiAgent && event.agentId ? `${event.agentId}: ` : '';
      // trailing blank line separates turns in the feed
      return (data.ok
        ? paint.green(`✓ ${tag}turn complete${secs}${cost}`)
        : paint.red(`✗ ${tag}turn failed${secs}`)) + '\n';
    }
    case 'agent_status': {
      const map = {
        starting: paint.dim(`· ${agentName} is starting…`),
        ready: paint.green(`· ${agentName} ready ${paint.dim(data.detail?.model ?? '')}`),
        working: paint.dim(`· ${agentName} is working…`),
        idle: null, // covered by the result line
        exited: paint.red(`· ${agentName} exited${data.detail?.code != null ? ` (code ${data.detail.code})` : ''}`),
        disconnected: paint.red(`· ${agentName} disconnected`),
        error: paint.red(`· ${agentName} error: ${data.detail?.message ?? ''}`),
      };
      return map[data.status] ?? null;
    }
    case 'agent_session_created':
      return actor.type === 'system'
        ? null // room creation: the agent roster line already says it
        : paint.green(`＋ ${event.agentId} added by ${name}`);
    case 'agent_session_attached':
      return paint.green(`● ${event.agentId ?? 'agent'} attached`);
    case 'agent_session_detached':
      return paint.dim(`○ ${event.agentId ?? 'agent'} detached — room stays open`);
    case 'turn_started':
    case 'turn_completed':
    case 'turn_failed':
      return null; // structural: the result line already tells the story
    case 'handoff_completed': {
      const to = data.to ?? {};
      const head = paint.cyan(`⇄ ${name} handed off to ${to.name ?? '?'}`);
      const objective = data.context?.objective;
      return objective ? `${head}\n  ${paint.dim(`objective: ${objective}`)}` : head;
    }
    case 'room_archived':
      return paint.dim(`▣ room archived by ${name} — join it again to reactivate`);
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
    case 'room_closed':
      return paint.red(`■ room closed — ${data.reason ?? 'the host left'}`) +
        (data.code ? `\n${paint.dim(`  history is saved — reopen with: collagent open ${data.code}`)}` : '');
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

  const agents = session.agents ?? [];
  let agentCells;
  if (agents.length > 1) {
    agentCells = agents.map((a) => (a.attached
      ? paint.magenta(`● ${a.agentId} [${a.status}]`)
      : paint.dim(`○ ${a.agentId} [detached]`)));
  } else {
    // single-agent rooms keep the brand name, exactly as before
    const agentName = agentLabel ?? session.agentType ?? 'agent';
    agentCells = [session.status === 'waiting_agent'
      ? paint.dim(`○ ${agentName} starting…`)
      : paint.magenta(`● ${agentName} [${session.status}${session.mode === 'driver' ? ', driver mode' : ''}]`)];
  }
  return `${people}  ${agentCells.join('  ')}`;
}

/** One line per agent session, for /agents. */
export function renderAgents(session, { agentLabel } = {}) {
  const agents = session.agents ?? [];
  if (!agents.length) return paint.dim('no agents yet — add one with /add <agent>');
  return agents
    .map((a) => {
      const mark = a.attached
        ? (a.status === 'working' ? paint.yellow('● working') : paint.green(`● ${a.status}`))
        : paint.dim('○ detached');
      const label = agents.length > 1 ? a.agentId : `${agentLabel ?? a.agentId} (${a.agentId})`;
      return `  ${paint.bold(label.padEnd(12))} ${mark}`;
    })
    .join('\n');
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
    const agentCount = room.agents?.length ?? room.agentIds?.length ?? 0;
    const agent = agentCount > 1
      ? `${room.agentGlyph ? `${room.agentGlyph} ` : ''}${agentCount} agents`
      : `${room.agentGlyph ? `${room.agentGlyph} ` : ''}${room.agentLabel ?? 'agent'}`;
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
  /agents              list the room's agents and their status
  /add <agent>         add another agent to the room (host/driver)
  /use <agent>         send your plain messages to that agent from now on
  /detach <agent>      detach an agent session (host/driver)
  /status              show session state
  /pause               pause the shared agents (host/driver)
  /resume              resume them
  /handoff <name>      hand control to a person, or focus to an agent
                       (/handoff bob · /handoff @codex-1)
  /mode open|driver    open: anyone can instruct; driver: only the driver
  /archive             archive the room — hidden from listings, joinable to revive (host)
  /end                 end the session for everyone (host)
  /quit                leave the session
  @<agent> <text>      address one agent in a multi-agent room
                       (@codex-1 inspect the frontend)
  /<agent command>     any other slash command runs in the shared agent
                       itself (/model, /permissions, /compact, …)
  //<command>          force a command to the agent when collagent owns the
                       name (e.g. //status runs the agent's /status)
  anything else        sent as an instruction — straight to the only agent,
                       or to your /use default when several are present
`;

/** Slash commands collagent answers locally; the rest belong to the agent. */
export const ROOM_COMMANDS = new Set([
  'help', 'participants', 'agents', 'add', 'use', 'detach',
  'status', 'pause', 'resume', 'handoff', 'mode', 'archive', 'end', 'quit', 'exit',
]);

/**
 * Route one line of participant input: collagent's own room commands are
 * handled locally, everything else — including the agent's slash commands —
 * goes to the shared agent, from any participant's terminal, whatever the
 * runtime. `@agent text` addresses one agent; `//x` force-sends `/x` when
 * collagent owns the same name.
 */
export function routeInput(text) {
  if (text.startsWith('//')) return { type: 'instruction', text: text.slice(1) };
  if (text.startsWith('@')) {
    const space = text.search(/\s/);
    if (space === -1) return { type: 'room', cmd: 'use', rest: [text.slice(1)] };
    const to = text.slice(1, space);
    const rest = text.slice(space + 1).trim();
    if (rest) return { type: 'instruction', to, text: rest };
    return { type: 'room', cmd: 'use', rest: [to] };
  }
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    if (ROOM_COMMANDS.has(cmd)) return { type: 'room', cmd, rest };
  }
  return { type: 'instruction', text };
}

/**
 * Interactive terminal loop shared by create and join.
 * onAddAgent(spec) — provided by the CLI — attaches another agent to the
 * room from this terminal (headless, so the feed stays usable).
 */
export function startTui({ client, onQuit, agentLabel = 'agent', onAddAgent = null }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: paint.bold('› '),
  });

  const multiAgent = () => (client.session?.agents?.length ?? 0) > 1;

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
    println(renderEvent(event, {
      selfId: client.self?.participantId,
      agentLabel,
      multiAgent: multiAgent(),
    }));
  });
  client.on('session', () => {}); // presence shown on demand via /participants
  client.on('ok', (message) => println(paint.dim(`· ${message}`)));
  client.on('server-error', (message) => println(paint.red(`! ${message}`)));
  client.on('disconnected', () => println(paint.red('· connection lost — reconnecting…')));
  client.on('reconnected', () => println(paint.green('· reconnected')));
  client.on('closed', () => {
    println(paint.dim('· connection closed'));
  });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();

    const routed = routeInput(text);
    if (routed.type === 'room') {
      const { cmd, rest } = routed;
      switch (cmd) {
        case 'help': println(HELP); break;
        case 'participants':
          println(renderPresence(client.session, client.self?.participantId, { agentLabel }));
          break;
        case 'agents':
          println(renderAgents(client.session, { agentLabel }));
          break;
        case 'add': {
          if (!rest[0]) {
            println(paint.red('usage: /add <agent>  (claude, codex, cursor, gemini, opencode, goose)'));
            break;
          }
          if (!onAddAgent) {
            println(paint.red(`this terminal cannot host an agent — run: collagent add ${client.session?.code} --agent ${rest[0]}`));
            break;
          }
          try {
            println(paint.dim(`· starting ${rest[0]}…`));
            const { agentId } = await onAddAgent(rest[0]);
            println(paint.green(`✓ ${agentId} is in the room — address it with @${agentId}`));
          } catch (err) {
            println(paint.red(`! could not add ${rest[0]}: ${err.message}`));
          }
          break;
        }
        case 'use':
          client.control('use_agent', { target: rest[0] ?? '' });
          break;
        case 'detach':
          client.control('detach_agent', { target: rest[0] ?? '' });
          break;
        case 'status': {
          const s = client.session;
          const online = s.participants.filter((p) => p.connected).length;
          const agentCell = (s.agents?.length ?? 1) > 1 ? `${s.agents.length} agents` : agentLabel;
          println(paint.dim(`room ${s.code} · ${agentCell} · ${s.status} · ${s.mode} mode · ${online} ${online === 1 ? 'person' : 'people'} here · ${s.eventCount} events`));
          break;
        }
        case 'pause': client.control('pause'); break;
        case 'resume': client.control('resume'); break;
        case 'handoff': client.control('handoff', { target: rest.join(' ') }); break;
        case 'mode': client.control('set_mode', { mode: rest[0] }); break;
        case 'archive': client.control('archive'); break;
        case 'end': client.control('end'); break;
        case 'quit':
        case 'exit':
          client.leave();
          rl.close();
          onQuit?.();
          return;
      }
      return rl.prompt();
    }

    client.sendInstruction(routed.text, { to: routed.to ?? null });
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
