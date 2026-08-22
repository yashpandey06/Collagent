/**
 * How a remote participant's instruction is written into the agent runtime.
 *
 * Plain instructions carry a visible speaker tag — "[Bob] add oauth" — so the
 * host and the model both see who is talking. Slash commands must reach the
 * runtime exactly as the host would type them ("/model", "/permissions"): a
 * speaker prefix would demote them to prose. Attribution isn't lost — the
 * server logs every instruction with its author in the room feed before it
 * reaches an adapter.
 */

import { sanitizeText, sanitizeName } from '../core/sanitize.js';

// A command is "/" + one word of letters/digits/_/-/: — matches every
// runtime's command grammar while leaving paths ("/src/app.js …") as prose.
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/;

export function isSlashCommand(text) {
  return SLASH_COMMAND.test(String(text ?? '').trim());
}

export function formatInstructionLine({ text, from }) {
  // The server sanitizes at ingress; stripping again here keeps a crafted
  // paste-terminator out of the PTY even if an adapter is fed directly.
  const raw = sanitizeText(String(text ?? ''));
  if (isSlashCommand(raw)) return raw.trim();
  const speaker = from?.name ? `[${sanitizeName(from.name)}] ` : '';
  return `${speaker}${raw}`;
}
