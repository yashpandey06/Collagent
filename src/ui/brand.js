import { paint } from './colors.js';

// The Collagent mark: three participant nodes joined at one hub.
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

export function logo() {
  return MARK.map((row, i) => {
    const art = `  ${painted(row)}`;
    if (i === HUB_ROW) return `${art}  ${paint.bold(paint.ink(WORDMARK))}`;
    if (i === HUB_ROW + 1) return `${art}  ${paint.dim(TAGLINE)}`;
    return art;
  });
}

export function printLogo() {
  console.log('');
  for (const line of logo()) console.log(line);
  console.log('');
}

export const wordmark = () => `${paint.accent('◉')} ${paint.bold('collagent')}`;
