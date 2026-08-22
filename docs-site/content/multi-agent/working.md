# Working With Multiple Agents

A multi-agent room looks like this:

```
Room A7K2

claude-1   ● working
codex-1    ● waiting

● Alice   ● Bob
```

## See the roster

```
/agents
```

## The rules of the room

- Each agent keeps its **own** conversation, tools and files — they never
  share a brain. What one agent says becomes a room event everyone (and no
  agent automatically) sees.
- Every feed line is labeled: `⏺ codex-1 …`, `✓ claude-1 turn complete`.
- With several agents attached, a plain message needs a target — Collagent
  asks instead of guessing. Address one agent or set a default
  ([Addressing](addressing.md)).
- Pause/resume applies to the whole room.

## Detach an agent

```
/detach codex-1
```

Host or driver. The room stays open; the agent can be re-added later. An
agent whose terminal dies detaches automatically — same result.
