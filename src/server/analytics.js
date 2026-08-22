/**
 * Dashboard aggregations, folded from real events and turns — a metric with
 * no underlying data reports zero/null rather than being invented.
 */

/** Cross-room overview: what is happening right now. */
export function buildOverview(sessions, { recentLimit = 20 } = {}) {
  const overview = {
    rooms: { total: 0, live: 0, working: 0, archived: 0 },
    agents: { attached: 0, working: 0, byRuntime: {} },
    people: { online: 0 },
    usage: { turns: 0, toolCalls: 0, durationMs: 0, inputTokens: null, outputTokens: null, providerCost: null },
    recent: [],
  };
  const recent = [];

  for (const session of sessions) {
    const snapshot = session.toJSON();
    overview.rooms.total++;
    if (snapshot.lifecycle === 'archived') overview.rooms.archived++;
    const online = snapshot.participants.filter((p) => p.connected).length;
    overview.people.online += online;
    if (online > 0 || snapshot.agents.some((a) => a.attached)) overview.rooms.live++;
    if (snapshot.status === 'working') overview.rooms.working++;

    for (const agent of snapshot.agents) {
      overview.agents.byRuntime[agent.runtime] = (overview.agents.byRuntime[agent.runtime] ?? 0) + 1;
      if (agent.attached) overview.agents.attached++;
      if (agent.attached && agent.status === 'working') overview.agents.working++;
    }

    for (const e of session.log.events.slice(-recentLimit)) {
      recent.push({ ...e, roomCode: session.code });
    }
    foldUsage(overview.usage, session.log.events);
  }

  overview.recent = recent
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    .slice(0, recentLimit);
  return overview;
}

/**
 * Time-windowed analytics. `readTurns(code)` supplies each room's complete
 * turn events from the store when it can (null → in-memory fallback).
 */
export async function buildAnalytics(sessions, { sinceTs = 0, room = null, runtime = null, readTurns = null } = {}) {
  const out = {
    since: sinceTs,
    totals: {
      runs: 0, failed: 0, durationMs: 0, toolCalls: 0,
      inputTokens: null, outputTokens: null, providerCost: null,
      instructions: 0, localPrompts: 0, handoffs: 0, errors: 0, agentAttaches: 0,
    },
    byRuntime: {}, // runtime -> { runs, durationMs, providerCost, inputTokens, outputTokens }
    byRoom: {},    // code -> { runs, instructions, lastActivity }
    activity: [],  // hour buckets: { ts, events, rooms }
  };
  const buckets = new Map(); // hourTs -> { events, rooms:Set }

  for (const session of sessions) {
    if (room && session.code !== room) continue;

    const turnEvents = (await readTurns?.(session.code))
      ?? session.log.events.filter((e) => e.kind === 'turn_completed' || e.kind === 'turn_failed');
    const events = session.log.events;
    const runtimeOfAgent = (agentId) =>
      session.getAgentSession?.(agentId)?.runtime ?? String(agentId ?? 'agent').split('-')[0];

    const roomRow = { code: session.code, runs: 0, instructions: 0, lastActivity: events.at(-1)?.ts ?? null };

    for (const e of turnEvents) {
      if ((e.ts ?? 0) < sinceTs) continue;
      const rt = runtimeOfAgent(e.agentId);
      if (runtime && rt !== runtime) continue;
      out.totals.runs++;
      roomRow.runs++;
      if (e.kind === 'turn_failed' || e.data?.ok === false) out.totals.failed++;
      out.totals.durationMs += e.data?.durationMs ?? 0;
      out.totals.toolCalls += e.data?.toolCalls ?? 0;
      const row = (out.byRuntime[rt] ??= { runs: 0, durationMs: 0, providerCost: null, inputTokens: null, outputTokens: null });
      row.runs++;
      row.durationMs += e.data?.durationMs ?? 0;
      const u = e.data?.usage ?? {};
      for (const [field, value] of Object.entries({
        inputTokens: u.inputTokens, outputTokens: u.outputTokens, providerCost: u.providerCost,
      })) {
        if (typeof value === 'number') {
          row[field] = (row[field] ?? 0) + value;
          out.totals[field] = (out.totals[field] ?? 0) + value;
        }
      }
    }

    for (const e of events) {
      if ((e.ts ?? 0) < sinceTs) continue;
      if (runtime && e.agentId && runtimeOfAgent(e.agentId) !== runtime) continue;
      switch (e.kind) {
        case 'instruction': out.totals.instructions++; roomRow.instructions++; break;
        case 'local_prompt': out.totals.localPrompts++; break;
        case 'handoff_completed': out.totals.handoffs++; break;
        case 'error': out.totals.errors++; break;
        case 'agent_session_attached': out.totals.agentAttaches++; break;
        default: break;
      }
      const hour = Math.floor((e.ts ?? 0) / 3_600_000) * 3_600_000;
      if (!buckets.has(hour)) buckets.set(hour, { events: 0, rooms: new Set() });
      const bucket = buckets.get(hour);
      bucket.events++;
      bucket.rooms.add(session.code);
    }

    if (roomRow.runs || roomRow.instructions) out.byRoom[session.code] = roomRow;
  }

  out.activity = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, b]) => ({ ts, events: b.events, rooms: b.rooms.size }));
  return out;
}

function foldUsage(usage, events) {
  for (const e of events) {
    if (e.kind !== 'turn_completed' && e.kind !== 'turn_failed') continue;
    usage.turns++;
    usage.toolCalls += e.data?.toolCalls ?? 0;
    usage.durationMs += e.data?.durationMs ?? 0;
    const u = e.data?.usage ?? {};
    for (const field of ['inputTokens', 'outputTokens', 'providerCost']) {
      if (typeof u[field] === 'number') usage[field] = (usage[field] ?? 0) + u[field];
    }
  }
}
