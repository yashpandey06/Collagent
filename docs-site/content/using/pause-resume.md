# Pause & Resume

Freeze the room's agents without losing anything.

## Pause

```
/pause
```

Host or driver only. While paused:

- new instructions are rejected with a clear message,
- instructions already queued stay queued,
- the room shows `⏸ paused` everywhere.

## Resume

```
/resume
```

Queued instructions flush to the agent in order.
