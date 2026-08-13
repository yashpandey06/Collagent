import { AgentAdapter } from './adapter.js';

/**
 * MockAdapter — a tiny fake agent used by tests and offline demos.
 * Emits the same normalized event shapes as a real adapter would.
 */
export class MockAdapter extends AgentAdapter {
  constructor(options = {}) {
    super(options);
    this.delay = options.delay ?? 5;
    this.paused = false;
    this.queue = [];
  }

  get info() {
    return { type: 'mock' };
  }

  async createSession() {
    this.emit({ kind: 'agent_status', status: 'starting' });
    await sleep(this.delay);
    this.emit({ kind: 'agent_status', status: 'ready', detail: { model: 'mock-1' } });
    return this.info;
  }

  async sendInstruction(instruction) {
    if (this.paused) {
      this.queue.push(instruction);
      return { queued: true };
    }
    return this._run(instruction);
  }

  async _run({ text, from }) {
    this.emit({ kind: 'agent_status', status: 'working' });
    await sleep(this.delay);
    this.emit({ kind: 'tool_use', tool: 'MockTool', input: JSON.stringify({ text }) });
    await sleep(this.delay);
    this.emit({ kind: 'tool_result', summary: 'ok', isError: false });
    this.emit({ kind: 'agent_message', text: `Echo for ${from?.name ?? 'someone'}: ${text}` });
    this.emit({ kind: 'result', ok: true, text: `done: ${text}`, durationMs: this.delay * 3 });
    this.emit({ kind: 'agent_status', status: 'idle' });
    return { queued: false };
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
    const held = this.queue.splice(0);
    for (const instruction of held) await this._run(instruction);
  }

  async disconnect() {
    this.emit({ kind: 'agent_status', status: 'exited', detail: { code: 0 } });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
