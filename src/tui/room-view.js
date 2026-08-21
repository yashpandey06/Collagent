import { paint } from '../client/tui.js';
import { agentLabel, catchupSummary, eventLines, joinDivider, statusCell } from './format.js';

/**
 * The room view: a live shared agent session. Pure render + key reducer;
 * src/tui/app.js owns the socket and feeds events in.
 *
 * Actions: {type:'back'} | {type:'quit'} | {type:'send', text} |
 *          {type:'pause'} | {type:'resume'} | {type:'attach'} | null
 */
export function roomState({ code, session, selfName, welcomeEvents, resumed, lastSeenSeq }) {
  const state = {
    code,
    session,
    selfName,
    allEvents: [...welcomeEvents],
    pre: [],
    live: [],
    mode: 'live', // live | history | input
    input: '',
    scroll: 0,
    message: null,
    connected: true,
    width: 80,
  };

  if (resumed && lastSeenSeq > 0) {
    const missed = welcomeEvents.filter((e) => e.seq > lastSeenSeq);
    const summary = catchupSummary(missed, { selfName });
    state.pre = summary.length
      ? ['', paint.bold('Since you were last here:'), '', ...summary.map((l) => paint.green(l)), '']
      : [paint.dim(''), paint.dim('Nothing happened while you were away.'), ''];
  }
  return state;
}

/** Recompute pre-divider preview for a first-time join at a given width. */
export function buildJoinPreview(state, width, previewEvents = 10) {
  if (state.pre.length) return; // returning user: catch-up card already built
  const shown = state.allEvents.slice(-previewEvents);
  const skipped = state.allEvents.length - shown.length;
  const lines = [];
  if (skipped > 0) lines.push(paint.dim(`… ${skipped} earlier events — press h for history`), '');
  for (const e of shown) lines.push(...eventLines(e, width));
  state.pre = lines;
}

export function appendLiveEvent(state, event, width) {
  state.allEvents.push(event);
  state.live.push(...eventLines(event, width));
  if (state.live.length > 4000) state.live.splice(0, state.live.length - 3000);
}

export function renderRoom(state, { cols, rows }) {
  const rule = paint.dim('─'.repeat(Math.max(20, cols - 2)));
  const s = state.session ?? {};
  const lines = [];

  lines.push('');
  lines.push(
    ` ${paint.bold(`COLLAGENT / ${state.code}`)}` +
    (state.connected ? '' : paint.red('   · connection lost — reconnecting…')),
  );
  lines.push(` ${rule}`);

  const roster = (s.participants ?? [])
    .map((p) => {
      const label = `${p.name}${p.id === s.driverId ? '*' : ''}${p.name === state.selfName ? ' (you)' : ''}`;
      return p.connected ? paint.green(`● ${label}`) : paint.dim(`○ ${label}`);
    })
    .join('   ');
  lines.push(` ${roster || paint.dim('nobody here yet')}`);
  lines.push(` ${paint.bold(agentLabel(s.agentType))} ${paint.dim('·')} ${statusCell(s.status)}${s.mode === 'driver' ? paint.dim('  · driver mode') : ''}`);
  lines.push(` ${rule}`);

  const feedRows = Math.max(4, rows - 9);
  const feed = [...state.pre, joinDivider(Math.max(30, cols - 6)), '', ...state.live];
  let view;
  if (state.mode === 'history') {
    const historyLines = [];
    for (const e of state.allEvents) historyLines.push(...eventLines(e, cols - 6));
    const end = Math.max(feedRows, historyLines.length - state.scroll);
    view = historyLines.slice(Math.max(0, end - feedRows), end);
    if (view.length === 0) view = [paint.dim('no history yet')];
  } else {
    view = feed.slice(-feedRows);
  }
  for (const line of view) lines.push(`  ${line}`);
  while (lines.length < rows - 2) lines.push('');

  if (state.message) lines[rows - 3] = ` ${paint.yellow(state.message)}`;
  lines.push(` ${rule}`);

  if (state.mode === 'input') {
    lines.push(` ${paint.bold(paint.cyan('›'))} ${state.input}${paint.yellow('▏')}  ${paint.dim('Enter send · Esc cancel')}`);
  } else if (state.mode === 'history') {
    lines.push(` ${paint.dim('HISTORY   ↑↓ scroll   PgUp/PgDn page   h/Esc back to live')}`);
  } else {
    const pauseKey = s.status === 'paused' ? 'p resume' : 'p pause';
    const attach = s.status === 'waiting_agent' && state.canAttach ? '   a attach agent' : '';
    lines.push(` ${paint.dim(`m message   h history   ${pauseKey}   b back   q quit${attach}`)}`);
  }
  return lines;
}

export function handleRoomKey(state, str, key) {
  state.message = null;

  if (state.mode === 'input') {
    if (key.name === 'escape') {
      state.mode = 'live';
      state.input = '';
    } else if (key.name === 'return' || key.name === 'enter') {
      const text = state.input.trim();
      state.mode = 'live';
      state.input = '';
      if (text) return { type: 'send', text };
    } else if (key.name === 'backspace') {
      state.input = state.input.slice(0, -1);
    } else if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ') {
      state.input += str;
    }
    return null;
  }

  if (state.mode === 'history') {
    switch (key.name) {
      case 'up': state.scroll += 1; return null;
      case 'down': state.scroll = Math.max(0, state.scroll - 1); return null;
      case 'pageup': state.scroll += 12; return null;
      case 'pagedown': state.scroll = Math.max(0, state.scroll - 12); return null;
      case 'h':
      case 'escape':
      case 'b':
        state.mode = 'live';
        state.scroll = 0;
        return null;
      case 'q': return { type: 'quit' };
      case 'c': return key.ctrl ? { type: 'quit' } : null;
      default: return null;
    }
  }

  switch (key.name) {
    case 'm': state.mode = 'input'; state.input = ''; return null;
    case 'h': state.mode = 'history'; state.scroll = 0; return null;
    case 'p':
      return state.session?.status === 'paused' ? { type: 'resume' } : { type: 'pause' };
    case 'a':
      return state.canAttach && state.session?.status === 'waiting_agent' ? { type: 'attach' } : null;
    case 'b':
    case 'escape':
      return { type: 'back' };
    case 'q':
      return { type: 'quit' };
    case 'c':
      return key.ctrl ? { type: 'quit' } : null;
    default:
      return null;
  }
}
