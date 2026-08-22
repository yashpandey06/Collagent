import { sanitizeText } from '../core/sanitize.js';

/**
 * Capture-time normalization for tool inputs/results and other payloads.
 * Stored events keep the complete safe payload (whitespace intact, control
 * bytes stripped) up to a generous safety cap — renderers truncate for
 * display, the event log does not.
 */
export const CAPTURE_LIMIT = 8192;

export function capture(value, max = CAPTURE_LIMIT) {
  let s;
  if (typeof value === 'string') s = value;
  else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  s = sanitizeText(String(s ?? '')).trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
