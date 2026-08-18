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
  /** Collagent's logo orange — the connector/ring accent. */
  accent: (s) => c('38;5;209', s),
  /** Node fill: bright on dark terminals, standing in for the logo's ink. */
  ink: (s) => c('1;97', s),
  invert: (s) => c('7', s),
};

export { useColor };
