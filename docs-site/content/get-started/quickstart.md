# Quickstart

Two terminals, two minutes.

## Terminal 1 — create a room

```
cd your-project
collagent create
```

Pick your agent from the list (or skip the picker with `--agent claude`).
You'll see a room code, then your **normal agent UI opens** — nothing about
it changes:

```
✓ Room created  A7K2 · Claude Code

  Invite your team   collagent join A7K2
  Watch in browser   http://localhost:7717/?code=A7K2
```

## Terminal 2 — join it

```
collagent join A7K2
```

Type an instruction at the `›` prompt:

```
› say hello and list the files here
```

Watch terminal 1: the message is typed into the agent's own prompt box as
`[you] …` and the agent answers. Terminal 2 streams the reply, every tool
call, and `✓ turn complete`.

## What just happened

1. `create` started a local Collagent server (if none was running) and a room.
2. Your real agent attached to the room.
3. `join` connected a second person to the same live session.
4. Everything both of you do is shared, live, and saved.

Next: [First Room](first-room.md) · [Agents](../agents/index.md)
