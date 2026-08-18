import { paint } from './colors.js';

/**
 * The Collagent mark: three participant nodes joined at one hub — the logo,
 * transcribed for a terminal. Outer nodes carry the ink, the hub and the
 * connectors carry the orange accent.
 */
const MARK = [
  '  ●     ●  ',
  '   ╲   ╱   ',
  '    ╲ ╱    ',
  '     ◉     ',
  '     │     ',
  '     ●     ',
];

const HUB_ROW = 3; // the row the wordmark aligns to
const WORDMARK = 'C O L L A G E N T';
const TAGLINE = 'multiplayer sessions for AI coding agents';

const painted = (row) =>
  row.replace(/[●◉]/g, (ch) => (ch === '◉' ? paint.accent(ch) : paint.ink(ch)))
    .replace(/[╲╱│]/g, (ch) => paint.accent(ch));

/**
 * The full horizontal lockup: mark on the left, wordmark on the hub line.
 * Returns lines so callers can decide on spacing and where to print it.
 */
export function logo() {
  return MARK.map((row, i) => {
    const art = `  ${painted(row)}`;
    if (i === HUB_ROW) return `${art}  ${paint.bold(paint.ink(WORDMARK))}`;
    if (i === HUB_ROW + 1) return `${art}  ${paint.dim(TAGLINE)}`;
    return art;
  });
}

/** Print the lockup with breathing room above and below. */
export function printLogo() {
  console.log('');
  for (const line of logo()) console.log(line);
  console.log('');
}

/** Single-line brand for tight spots (room banners, status headers). */
export const wordmark = () => `${paint.accent('◉')} ${paint.bold('collagent')}`;
