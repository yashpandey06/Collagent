import { paint } from '../client/tui.js';

export const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
export const visLen = (s) => visible(s).length;

export function padCell(s, width) {
  const len = visLen(s);
  if (len >= width) return clip(s, width);
  return s + ' '.repeat(width - len);
}

export function clip(s, width) {
  if (visLen(s) <= width) return s;
  let out = '';
  let len = 0;
  const parts = String(s).split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (part.startsWith('\x1b')) {
      out += part;
      continue;
    }
    const room = width - 1 - len;
    if (room <= 0) break;
    out += part.slice(0, room);
    len += Math.min(part.length, room);
  }
  return out + '…\x1b[0m';
}

export function hhmm(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function wrapText(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export function filterRooms(rooms, query) {
  const q = String(query ?? '').trim().toUpperCase();
  if (!q) return rooms;
  return rooms.filter(
    (r) => r.code.includes(q) || String(r.agentType ?? '').toUpperCase().includes(q),
  );
}

export function roomCounts(room) {
  const roster = room.participants ?? [];
  const inCount = roster.filter((p) => p.connected).length;
  const people = Math.max(room.participantsEver?.length ?? 0, roster.length);
  return { people, inCount };
}

export function statusCell(status) {
  switch (status) {
    case 'working': return paint.yellow('● working');
    case 'paused': return paint.yellow('⏸ paused');
    case 'waiting_agent': return paint.dim('○ waiting');
    case 'idle': return paint.green('● idle');
    default: return paint.dim(`○ ${status ?? 'unknown'}`);
  }
}

export function agentLabel(agentType) {
  if (!agentType) return 'agent';
  if (agentType.startsWith('claude')) return 'Claude';
  if (agentType === 'mock') return 'Mock';
  return agentType;
}

/**
 * Turn one session event into zero or more display lines for the room feed.
 * Returns [] for events that are noise in a live transcript.
 */
export function eventLines(event, width) {
  const { kind, actor = {}, data = {}, ts } = event;
  const t = paint.dim(hhmm(ts));
  const bodyWidth = Math.max(24, width - 2);

  const speakerBlock = (name, color, text) => {
    const head = `${t} ${paint.bold(paint[color](name))}`;
    return [head, ...wrapText(text, bodyWidth), ''];
  };

  switch (kind) {
    case 'instruction':
      return speakerBlock(actor.name ?? 'someone', 'cyan', data.text ?? '');
    case 'local_prompt':
      return speakerBlock('host terminal', 'blue', data.text ?? '');
    case 'agent_message':
      return speakerBlock('Claude', 'magenta', data.text ?? '');
    case 'tool_use':
      return [`${t} ${paint.dim(`⚙ ${data.tool ?? 'tool'} ${clip(String(data.input ?? ''), Math.max(10, bodyWidth - 14))}`)}`];
    case 'result':
      return [
        `${t} ${data.ok ? paint.green('✓ turn complete') : paint.red('✗ turn failed')}${data.durationMs ? paint.dim(` · ${(data.durationMs / 1000).toFixed(1)}s`) : ''}`,
        '',
      ];
    case 'participant_joined':
      return [`${t} ${paint.green(`+ ${actor.name} joined`)}`];
    case 'participant_left':
      return [`${t} ${paint.dim(`− ${actor.name} left`)}`];
    case 'participant_disconnected':
      return [`${t} ${paint.dim(`○ ${actor.name} stepped away`)}`];
    case 'participant_reconnected':
      return [`${t} ${paint.green(`● ${actor.name} is back`)}`];
    case 'session_paused':
      return [`${t} ${paint.yellow(`⏸ paused by ${actor.name}`)}`];
    case 'session_resumed':
      return [`${t} ${paint.green(`▶ resumed by ${actor.name}`)}`];
    case 'control_transferred':
      return [`${t} ${paint.cyan(`⇄ control handed to ${data.to?.name}`)}`];
    case 'mode_changed':
      return [`${t} ${paint.cyan(`⚑ mode: ${data.mode}`)}`];
    case 'notice':
      return [`${t} ${paint.yellow(`🔔 ${clip(String(data.message ?? ''), bodyWidth - 10)}`)}`];
    case 'session_ended':
      return [`${t} ${paint.red(`■ session ended by ${actor.name}`)}`];
    case 'error':
      return [`${t} ${paint.red(`! ${clip(String(data.message ?? ''), bodyWidth - 4)}`)}`];
    default:
      return []; // agent_status churn, session_created, tool_result: noise here
  }
}

export function joinDivider(width, label = 'YOU JOINED HERE') {
  const inner = ` ${label} `;
  const side = Math.max(4, Math.floor((width - inner.length) / 2));
  return paint.dim('─'.repeat(side)) + paint.bold(inner) + paint.dim('─'.repeat(Math.max(4, width - side - inner.length)));
}

/**
 * Summarize what happened while this user was away — instead of replaying
 * every line. Returns short "✓ ..." strings.
 */
export function catchupSummary(events, { selfName } = {}) {
  const lines = [];
  const joined = [];
  const left = [];
  const redirects = [];
  let edits = 0;
  let commands = 0;
  let otherTools = 0;
  let turns = 0;

  for (const e of events) {
    const name = e.actor?.name;
    switch (e.kind) {
      case 'participant_joined':
        if (name !== selfName) joined.push(name);
        break;
      case 'participant_left':
        if (name !== selfName) left.push(name);
        break;
      case 'instruction':
      case 'local_prompt':
        if (name !== selfName) redirects.push({ name: e.kind === 'local_prompt' ? 'host' : name, text: e.data?.text ?? '' });
        break;
      case 'tool_use': {
        const tool = String(e.data?.tool ?? '');
        if (/write|edit|notebookedit/i.test(tool)) edits++;
        else if (/bash/i.test(tool)) commands++;
        else otherTools++;
        break;
      }
      case 'result':
        turns++;
        break;
      default:
        break;
    }
  }

  if (joined.length) lines.push(`✓ ${[...new Set(joined)].join(', ')} joined`);
  if (left.length) lines.push(`✓ ${[...new Set(left)].join(', ')} left`);
  for (const r of redirects.slice(-2)) {
    lines.push(`✓ ${r.name}: “${r.text.length > 46 ? r.text.slice(0, 46) + '…' : r.text}”`);
  }
  if (edits) lines.push(`✓ Claude changed ${edits} file${edits === 1 ? '' : 's'}`);
  if (commands) lines.push(`✓ ran ${commands} command${commands === 1 ? '' : 's'}`);
  if (otherTools) lines.push(`✓ ${otherTools} other tool action${otherTools === 1 ? '' : 's'}`);
  if (turns) lines.push(`✓ ${turns} turn${turns === 1 ? '' : 's'} completed`);
  return lines.slice(0, 6);
}
