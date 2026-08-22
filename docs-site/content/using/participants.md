# Participants

## Roles

- **host** — created the room (or adopted a hostless one). Can `/end`,
  `/archive`, change `/mode`.
- **driver** — one participant holds the driver seat; starts as the host and
  moves via [handoff](handoff.md).
- everyone else — collaborators.

## Open vs driver mode

```
/mode driver
```

In `open` mode (default) anyone can instruct the agent. In `driver` mode only
the driver or host can; others are told to ask for a handoff.

```
/mode open
```

## Presence

```
/participants
```

`●` connected, `○` stepped away. If your name is taken you become `name-2`;
pick another with `--name` when joining.

## Leaving

```
/quit
```

An explicit `/quit` gives your seat up (rejoining a remote room needs the key
again). Just losing connection keeps your seat — you resume as the same
person.
