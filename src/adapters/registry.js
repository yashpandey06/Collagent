import fs from 'node:fs';
import path from 'node:path';
import { ClaudeNativeAdapter } from './claude/native.js';
import { ClaudeCodeAdapter } from './claude/headless.js';
import { CodexNativeAdapter } from './codex/native.js';
import { CodexAppServerAdapter } from './codex/app-server.js';
import { CursorNativeAdapter } from './cursor/native.js';
import { CursorAgentAdapter } from './cursor/headless.js';
import { GeminiNativeAdapter } from './gemini/native.js';
import { OpencodeNativeAdapter } from './opencode/native.js';
import { GooseNativeAdapter } from './goose/native.js';
import { AcpAdapter } from './acp/client.js';
import { MockAdapter } from './mock.js';

/**
 * RUNTIMES is what a human picks ("which coding agent?"); ADAPTERS is what the
 * code instantiates. Descriptors carry capabilities so callers never branch on
 * names: ownsTerminal (runtime UI takes the terminal, no Collagent TUI) and
 * resumeOptions (stored session id → adapter options).
 */

// glyph: the vendor mark's closest terminal form; the web page draws real SVGs.
export const RUNTIMES = [
  {
    id: 'claude',
    bin: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    label: 'Claude Code',
    vendor: 'Anthropic',
    glyph: '✳',
    note: 'native UI · hooks · status line',
    status: 'available',
    adapters: { interactive: 'claude-native', headless: 'claude-code' },
  },
  {
    id: 'codex',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
    label: 'Codex',
    vendor: 'OpenAI',
    glyph: '⬡',
    note: 'native UI · hooks · app-server threads',
    status: 'available',
    adapters: { interactive: 'codex-native', headless: 'codex' },
  },
  {
    id: 'cursor',
    bin: 'agent',
    install: 'curl https://cursor.com/install -fsS | bash',
    label: 'Cursor',
    vendor: 'Anysphere',
    glyph: '◆',
    note: 'native UI · hooks · print mode',
    status: 'available',
    adapters: { interactive: 'cursor-native', headless: 'cursor' },
  },
  {
    id: 'gemini',
    bin: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    label: 'Gemini CLI',
    vendor: 'Google',
    glyph: '✦',
    note: 'native UI · hooks · ACP',
    status: 'available',
    adapters: { interactive: 'gemini-native', headless: 'gemini' },
  },
  {
    id: 'opencode',
    bin: 'opencode',
    install: 'npm install -g opencode-ai',
    label: 'OpenCode',
    vendor: 'Anomaly',
    glyph: '▌',
    note: 'native UI · server events · ACP',
    status: 'available',
    adapters: { interactive: 'opencode-native', headless: 'opencode' },
  },
  {
    id: 'goose',
    bin: 'goose',
    install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
    label: 'Goose',
    vendor: 'Block',
    glyph: '◈',
    note: 'native UI · hooks · ACP',
    status: 'available',
    adapters: { interactive: 'goose-native', headless: 'goose' },
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
  'cursor-native': {
    label: 'Cursor',
    runtime: 'cursor',
    ownsTerminal: true,
    resumeOptions: (id) => ({ extraArgs: ['--resume', id] }),
    create: (options) => new CursorNativeAdapter(options),
  },
  cursor: {
    label: 'Cursor (print mode)',
    runtime: 'cursor',
    ownsTerminal: false,
    resumeOptions: (id) => ({ sessionId: id, resume: true }),
    create: (options) => new CursorAgentAdapter(options),
  },
  'gemini-native': {
    label: 'Gemini CLI',
    runtime: 'gemini',
    ownsTerminal: true,
    resumeOptions: (id) => ({ extraArgs: ['--resume', id] }),
    create: (options) => new GeminiNativeAdapter(options),
  },
  gemini: {
    label: 'Gemini CLI (ACP)',
    runtime: 'gemini',
    ownsTerminal: false,
    resumeOptions: (id) => ({ sessionId: id, resume: true }),
    create: (options) => new AcpAdapter({ command: 'gemini', args: ['--acp'], label: 'gemini', ...options }),
  },
  'opencode-native': {
    label: 'OpenCode',
    runtime: 'opencode',
    ownsTerminal: true,
    resumeOptions: (id) => ({ sessionId: id, resume: true }),
    create: (options) => new OpencodeNativeAdapter(options),
  },
  opencode: {
    label: 'OpenCode (ACP)',
    runtime: 'opencode',
    ownsTerminal: false,
    resumeOptions: (id) => ({ sessionId: id, resume: true }),
    create: (options) => new AcpAdapter({ command: 'opencode', args: ['acp'], label: 'opencode', ...options }),
  },
  'goose-native': {
    label: 'Goose',
    runtime: 'goose',
    ownsTerminal: true,
    resumeOptions: (id) => ({ extraArgs: ['--session-id', id, '--resume'] }),
    create: (options) => new GooseNativeAdapter(options),
  },
  goose: {
    label: 'Goose (ACP)',
    runtime: 'goose',
    ownsTerminal: false,
    resumeOptions: (id) => ({ sessionId: id, resume: true }),
    create: (options) => new AcpAdapter({ command: 'goose', args: ['acp'], label: 'goose', ...options }),
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

/** Brand name for a room's agent — adapter ids resolve to runtime labels. */
export function runtimeLabel(agentType) {
  try {
    const descriptor = describeAdapter(agentType);
    return findRuntime(descriptor.runtime)?.label ?? descriptor.label;
  } catch {
    return agentType && agentType !== 'unknown' ? String(agentType) : 'agent';
  }
}

// PATH-based on purpose: report installed only where spawn would succeed.
export function isRuntimeInstalled(runtime) {
  if (!runtime?.bin) return true;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, runtime.bin), fs.constants.X_OK);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

export function runtimesWithInstallState() {
  return RUNTIMES.map((r) => ({ ...r, installed: isRuntimeInstalled(r) }));
}

/** Terminal brand mark for a room's agent, '' when unknown. */
export function runtimeGlyph(agentType) {
  try {
    return findRuntime(describeAdapter(agentType).runtime)?.glyph ?? '';
  } catch {
    return '';
  }
}

/** The adapter id for a runtime, in the mode the current terminal supports. */
export function adapterFor(runtimeId, { headless = false } = {}) {
  const runtime = findRuntime(runtimeId);
  if (!runtime) return null;
  return headless
    ? runtime.adapters.headless ?? runtime.adapters.interactive ?? null
    : runtime.adapters.interactive ?? runtime.adapters.headless ?? null;
}
