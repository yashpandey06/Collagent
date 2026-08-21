import readline from 'node:readline';
import { clip } from './format.js';

/**
 * Minimal full-screen terminal engine: alternate screen buffer, raw keys,
 * flicker-free full-frame redraws (home + per-line clear, never a full
 * screen clear), resize handling, and guaranteed terminal restore.
 */
export class Term {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.keyHandler = null;
    this._active = false;
    this._onKeypress = (str, key) => this.keyHandler?.(str, key ?? {});
    this._onResize = () => this.resizeHandler?.();
    this.resizeHandler = null;
  }

  get size() {
    return {
      cols: this.output.columns || 100,
      rows: this.output.rows || 32,
    };
  }

  start() {
    if (this._active) return;
    this._active = true;
    readline.emitKeypressEvents(this.input);
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on('keypress', this._onKeypress);
    this.output.on('resize', this._onResize);
    this.output.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    this.input.off('keypress', this._onKeypress);
    this.output.off('resize', this._onResize);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.output.write('\x1b[?25h\x1b[?1049l'); // show cursor, main screen
  }

  /** Render a full frame: array of lines, top to bottom. */
  draw(lines) {
    if (!this._active) return;
    const { cols, rows } = this.size;
    const frame = lines
      .slice(0, rows)
      .map((line) => clip(line ?? '', cols) + '\x1b[K')
      .join('\r\n');
    this.output.write('\x1b[H' + frame + '\x1b[0J');
  }
}

export const isPrintable = (str, key) =>
  Boolean(str) && str.length === 1 && !key.ctrl && !key.meta && str >= ' ' && str !== '\x7f';
