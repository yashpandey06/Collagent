/**
 * Terminal-safety for remote text. Anything a participant sends can end up
 * written into the host's PTY (bracketed paste) and rendered in every other
 * participant's terminal, so control bytes are stripped at the server edge:
 * ESC kills ANSI styling and bracketed-paste breakouts (ESC[201~), the rest
 * of C0 (except newline and tab) covers raw control-key smuggling.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F]', 'g');

export function sanitizeText(text) {
  return String(text ?? '').replace(CONTROL, '');
}

/** Display names additionally collapse whitespace and get a length cap. */
export function sanitizeName(name, max = 32) {
  return sanitizeText(name).replace(/\s+/g, ' ').trim().slice(0, max);
}
