# Joining a Room

Join an existing room using its room code.

## Terminal

```
collagent join A7K2
```

## What happens

1. Collagent connects to the server.
2. You get a catch-up of the room's history (a digest when it's long).
3. You join the live session — new activity streams in automatically.
4. Anything you type at `›` goes to the agent, attributed to you.

## Useful options

```
collagent join A7K2 --name Bob
```

```
collagent join A7K2 --key f3a9c1e0d2 --server ws://192.168.1.20:7717
```

`--name` sets your display name (duplicates get `-2` suffixes). `--key` is
the room's join key — needed only on remote servers; the host's invite line
includes it. From the browser, open the room's web link instead.
