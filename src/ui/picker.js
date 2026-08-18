import readline from 'node:readline';
import { paint } from './colors.js';
import { printLogo } from './brand.js';

const HINT = '↑↓ move · enter select · q cancel';

function rows(runtimes, cursor) {
  const width = Math.max(...runtimes.map((r) => r.label.length));
  return runtimes.map((runtime, i) => {
    const soon = runtime.status !== 'available';
    const selected = i === cursor;
    const bullet = soon ? '○' : '●';
    const label = runtime.label.padEnd(width);
    const vendor = runtime.vendor.padEnd(10);

    if (soon) {
      return `    ${paint.dim(`${bullet}  ${label}  ${vendor}  ${runtime.note}`)}`;
    }
    const body = `${bullet}  ${label}  ${paint.dim(vendor)}  ${paint.dim(runtime.note)}`;
    return selected
      ? `  ${paint.accent('❯')} ${paint.accent(bullet)}  ${paint.bold(label)}  ${paint.dim(vendor)}  ${paint.dim(runtime.note)}`
      : `    ${body}`;
  });
}

/**
 * Interactive runtime chooser. Renders the Collagent lockup, then a list of
 * coding agents, and redraws in place as the selection moves.
 *
 * Resolves with the chosen runtime, or null if the user cancelled. Leaves
 * stdin exactly as it found it — the adapter that runs next may want raw mode
 * for its own PTY.
 */
export function pickRuntime(runtimes, { title = 'Choose your coding agent' } = {}) {
  const selectable = runtimes.filter((r) => r.status === 'available');
  if (!selectable.length) return Promise.resolve(null);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(selectable[0]);

  printLogo();
  console.log(`  ${paint.bold(title)}`);
  console.log('');

  let cursor = 0;
  let painted = 0;

  const draw = () => {
    if (painted) process.stdout.write(`\x1b[${painted}A`);
    const lines = [...rows(runtimes, cursor), '', `  ${paint.dim(HINT)}`];
    for (const line of lines) process.stdout.write(`\x1b[2K${line}\n`);
    painted = lines.length;
  };

  const step = (delta) => {
    // Skip past runtimes that are not selectable yet.
    for (let i = 1; i <= runtimes.length; i++) {
      const next = (cursor + delta * i + runtimes.length * i) % runtimes.length;
      if (runtimes[next].status === 'available') return next;
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
        if (runtimes[index]?.status === 'available') { cursor = index; draw(); }
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
