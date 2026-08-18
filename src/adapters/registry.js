import { ClaudeNativeAdapter } from './claude/native.js';
import { ClaudeCodeAdapter } from './claude/headless.js';
import { CodexNativeAdapter } from './codex/native.js';
import { CodexAppServerAdapter } from './codex/app-server.js';
import { MockAdapter } from './mock.js';

/**
 * Two registries, because they answer two different questions.
 *
 * RUNTIMES is what a human chooses: "which coding agent?". Each runtime offers
 * an interactive adapter (its own native UI) and a headless one (Collagent
 * renders the feed).
 *
 * ADAPTERS is what the code instantiates. Each descriptor carries the
 * capabilities that callers used to infer from adapter names:
 *
 *   ownsTerminal   the adapter takes over this terminal with the runtime's own
 *                  UI, so Collagent must not start its own TUI on top of it
 *   resumeOptions  turns a stored runtime session id into adapter options,
 *                  keeping each runtime's resume convention in one place
 */

export const RUNTIMES = [
  {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    note: 'native UI · hooks · status line',
    status: 'available',
    adapters: { interactive: 'claude-native', headless: 'claude-code' },
  },
  {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    note: 'native UI · hooks · app-server threads',
    status: 'available',
    adapters: { interactive: 'codex-native', headless: 'codex' },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    vendor: 'Anysphere',
    note: 'coming soon',
    status: 'coming-soon',
    adapters: {},
  },
];

const ADAPTERS = {
  'claude-native': {
    label: 'Claude Code',
    runtime: 'claude',
    ownsTerminal: true,
    resumeOptions: (id) => ({ extraArgs: ['--resume', id] }),
    create: (options) => new ClaudeNativeAdapter(options),
  },
  'claude-code': {
    label: 'Claude Code (headless)',
    runtime: 'claude',
    ownsTerminal: false,
    resumeOptions: (id) => ({ sessionId: id, resume: true }),
    create: (options) => new ClaudeCodeAdapter(options),
  },
  'codex-native': {
    label: 'Codex',
    runtime: 'codex',
    ownsTerminal: true,
    resumeOptions: (id) => ({ extraArgs: ['resume', id] }),
    create: (options) => new CodexNativeAdapter(options),
  },
  codex: {
    label: 'Codex (app server)',
    runtime: 'codex',
    ownsTerminal: false,
    resumeOptions: (id) => ({ threadId: id, resume: true }),
    create: (options) => new CodexAppServerAdapter(options),
  },
  mock: {
    label: 'Mock agent',
    runtime: 'mock',
    ownsTerminal: false,
    resumeOptions: () => ({}),
    create: (options) => new MockAdapter(options),
  },
};

export function describeAdapter(type) {
  const descriptor = ADAPTERS[type];
  if (!descriptor) {
    throw new Error(`unknown agent adapter "${type}" (available: ${adapterTypes().join(', ')})`);
  }
  return descriptor;
}

export function createAdapter(type, options = {}) {
  return describeAdapter(type).create(options);
}

export function adapterTypes() {
  return Object.keys(ADAPTERS);
}

/** Runtimes a human can actually pick right now. */
export const availableRuntimes = () => RUNTIMES.filter((r) => r.status === 'available');

export const findRuntime = (id) =>
  RUNTIMES.find((r) => r.id === String(id).toLowerCase()) ?? null;

/** The adapter id for a runtime, in the mode the current terminal supports. */
export function adapterFor(runtimeId, { headless = false } = {}) {
  const runtime = findRuntime(runtimeId);
  if (!runtime) return null;
  return headless
    ? runtime.adapters.headless ?? runtime.adapters.interactive ?? null
    : runtime.adapters.interactive ?? runtime.adapters.headless ?? null;
}
