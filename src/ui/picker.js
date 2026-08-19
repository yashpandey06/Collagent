import readline from 'node:readline';
import { paint } from './colors.js';
import { printLogo } from './brand.js';

const HINT = '↑↓ move · enter select · q cancel';

const selectable = (runtime) => runtime.status === 'available' && runtime.installed !== false;

function rows(runtimes, cursor) {
  const width = Math.max(...runtimes.map((r) => r.label.length));
  // one line per runtime, whatever the terminal width — a wrapped row breaks
  // the in-place redraw
  const noteBudget = Math.max(14, (process.stdout.columns || 100) - (width + 22));
  const fit = (s) => (s.length > noteBudget ? s.slice(0, noteBudget - 1) + '…' : s);

  return runtimes.map((runtime, i) => {
    const selected = i === cursor;
    const mark = runtime.glyph ?? '●';
    const label = runtime.label.padEnd(width);
    const vendor = runtime.vendor.padEnd(10);

    if (!selectable(runtime)) {
      const why = runtime.status !== 'available'
        ? runtime.note
        : `not installed · ${runtime.install ?? 'see vendor docs'}`;
      return `    ${paint.dim(`${mark}  ${label}  ${vendor}  ${fit(why)}`)}`;
    }
    return selected
      ? `  ${paint.accent('❯')} ${paint.accent(mark)}  ${paint.bold(label)}  ${paint.dim(vendor)}  ${paint.dim(fit(runtime.note))}`
      : `    ${paint.ink(mark)}  ${label}  ${paint.dim(vendor)}  ${paint.dim(fit(runtime.note))}`;
  });
}

// Arrow-key Yes/No for destructive actions. Defaults to No; resolves false
// without a TTY so scripts can never confirm by accident.
export function confirmDanger({ title, detail, yes = 'Yes, delete it', no = 'No, keep it' }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);

  console.log(`  ${paint.bold(title)}`);
  if (detail) console.log(`  ${paint.dim(detail)}`);
  console.log('');

  const options = [no, yes];
  let cursor = 0;
  let painted = 0;

  const draw = () => {
    if (painted) process.stdout.write(`\x1b[${painted}A`);
    const lines = options.map((label, i) => {
      const text = i === 1 ? paint.red(label) : label;
      return i === cursor ? `  ${paint.accent('❯')} ${paint.bold(text)}` : `    ${text}`;
    });
    lines.push('', `  ${paint.dim('↑↓ move · enter confirm · esc cancel')}`);
    for (const line of lines) process.stdout.write(`\x1b[2K${line}\n`);
    painted = lines.length;
  };

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?25l');

    const finish = (answer) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      if (!wasRaw) process.stdin.pause();
      process.stdout.write('\x1b[?25h');
      console.log('');
      resolve(answer);
    };

    const onKey = (_str, key = {}) => {
      if (key.name === 'up' || key.name === 'down' || key.name === 'k' || key.name === 'j') {
        cursor = cursor === 0 ? 1 : 0;
        return draw();
      }
      if (key.name === 'y') { cursor = 1; draw(); return finish(true); }
      if (key.name === 'n') { cursor = 0; draw(); return finish(false); }
      if (key.name === 'return' || key.name === 'enter') { draw(); return finish(cursor === 1); }
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        draw();
        return finish(false);
      }
    };

    process.stdin.on('keypress', onKey);
    draw();
  });
}

// Interactive runtime chooser. Resolves with the chosen runtime or null.
// Leaves stdin as it found it — the adapter that runs next may want raw mode.
export function pickRuntime(runtimes, { title = 'Choose your coding agent' } = {}) {
  const choices = runtimes.filter(selectable);
  if (!choices.length) return Promise.resolve(null);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(choices[0]);

  printLogo();
  console.log(`  ${paint.bold(title)}`);
  console.log('');

  let cursor = runtimes.findIndex(selectable);
  let painted = 0;

  const draw = () => {
    if (painted) process.stdout.write(`\x1b[${painted}A`);
    const lines = [...rows(runtimes, cursor), '', `  ${paint.dim(HINT)}`];
    for (const line of lines) process.stdout.write(`\x1b[2K${line}\n`);
    painted = lines.length;
  };

  const step = (delta) => {
    for (let i = 1; i <= runtimes.length; i++) {
      const next = (cursor + delta * i + runtimes.length * i) % runtimes.length;
      if (selectable(runtimes[next])) return next;
    }
    return cursor;
  };

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?25l'); // hide cursor while the list is live

    const finish = (runtime) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      if (!wasRaw) process.stdin.pause();
      process.stdout.write('\x1b[?25h');
      resolve(runtime);
    };

    const onKey = (_str, key = {}) => {
      if (key.name === 'up' || key.name === 'k') { cursor = step(-1); return draw(); }
      if (key.name === 'down' || key.name === 'j') { cursor = step(1); return draw(); }

      if (/^[1-9]$/.test(key.sequence ?? '')) {
        const index = Number(key.sequence) - 1;
        if (runtimes[index] && selectable(runtimes[index])) { cursor = index; draw(); }
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        draw();
        console.log('');
        return finish(runtimes[cursor]);
      }
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        draw();
        console.log('');
        return finish(null);
      }
    };

    process.stdin.on('keypress', onKey);
    draw();
  });
}
