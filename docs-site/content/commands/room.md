# Room Commands

Type these at the `›` prompt inside a room. Anything else you type is an
instruction to the agent — including the agent's own slash commands.

| Command | What it does | Who |
|---|---|---|
| /participants | who is here, with host/driver markers | everyone |
| /status | room state in one line | everyone |
| /agents | agent roster and states | everyone |
| /add <agent> | add another agent (headless, in this terminal) | host/driver |
| /use <agent> | send your plain messages to that agent | everyone |
| /detach <agent> | detach an agent session | host/driver |
| /pause | pause the agents; instructions queue | host/driver |
| /resume | resume; queued instructions flush | host/driver |
| /handoff <name> | hand control to a person | host/driver |
| /handoff @<agent> | move room focus to an agent | host/driver |
| /mode open·driver | who may instruct | host |
| /archive | archive the room (revives on join) | host |
| /end | end the room for everyone | host |
| /quit | leave the room | everyone |
| @<agent> <text> | address one agent (multi-agent rooms) | everyone |
| //<command> | force a command to the agent when Collagent owns the name | everyone |

## Agent slash commands

```
/model
```

Runs in the shared agent exactly as if the host typed it — on every supported
runtime, from any participant's terminal.
