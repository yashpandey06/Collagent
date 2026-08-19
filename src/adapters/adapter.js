/**
 * The contract between Collagent Core and any agent runtime. The core only
 * ever sees these normalized events; new runtimes implement this interface
 * and register in registry.js.
 *
 *   agent_status  { status: starting|ready|working|idle|exited|error, detail? }
 *   agent_message { text }
 *   tool_use      { tool, input }
 *   tool_result   { tool?, summary, isError? }
 *   result        { ok, text?, durationMs?, costUsd? }
 *   error         { message }
 *   session_title { title }            agent-provided room topic
 *   local_prompt  { text }             host typed in a native UI
 *   notice        { message }          native UI needs the host's attention
 *
 * Adapters wanting resume support emit sessionId in agent_status.detail.
 */
export class AgentAdapter {
  constructor(options = {}) {
    this.options = options;
    this._listeners = new Set();
  }

  /** Static metadata about the runtime this adapter drives. */
  get info() {
    return { type: 'abstract' };
  }

  /** Subscribe to normalized agent events (the receiveEvents side). */
  attach(onEvent) {
    this._listeners.add(onEvent);
    return () => this._listeners.delete(onEvent);
  }

  emit(event) {
    for (const fn of this._listeners) fn(event);
  }

  /** Start the underlying agent session. Resolves when the agent is usable. */
  async createSession() {
    throw new Error('not implemented');
  }

  /** Deliver an instruction: { text, from: {id, name} }. */
  async sendInstruction(_instruction) {
    throw new Error('not implemented');
  }

  /** Stop accepting new instructions (queue them) until resume(). */
  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
  }

  /** Control was handed to another participant; adapters may inform the agent. */
  async handoff(_info) {}

  /** Tear down the underlying agent session. */
  async disconnect() {}
}
