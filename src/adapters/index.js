import { ClaudeCodeAdapter } from './claude-code.js';
import { ClaudeNativeAdapter } from './claude-native.js';
import { MockAdapter } from './mock.js';

/**
 * Adapter registry. Future runtimes (Lovable, Cursor, Replit, custom agents)
 * plug in here without any change to Collagent Core.
 *
 *   claude-native — the host keeps the real interactive Claude Code UI
 *                   (PTY passthrough + hooks). Default for `collagent create`.
 *   claude-code   — headless stream-json mode, for scripting/tests/demo.
 */
const ADAPTERS = {
  'claude-native': ClaudeNativeAdapter,
  'claude-code': ClaudeCodeAdapter,
  mock: MockAdapter,
};

export function createAdapter(type, options = {}) {
  const Adapter = ADAPTERS[type];
  if (!Adapter) {
    throw new Error(`unknown agent adapter "${type}" (available: ${Object.keys(ADAPTERS).join(', ')})`);
  }
  return new Adapter(options);
}

export function adapterTypes() {
  return Object.keys(ADAPTERS);
}
