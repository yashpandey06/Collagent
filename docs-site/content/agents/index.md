# Agents

Collagent connects to agent runtimes through adapters. Pick the agent you use
to see exactly how to connect and collaborate:

| Agent | Vendor | Page |
|---|---|---|
| Claude Code | Anthropic | [Claude Code](claude-code.md) |
| Codex | OpenAI | [Codex](codex.md) |
| Cursor | Anysphere | [Cursor](cursor.md) |
| Gemini CLI | Google | [Gemini CLI](gemini-cli.md) |
| Goose | Block | [Goose](goose.md) |
| OpenCode | Anomaly | [OpenCode](opencode.md) |

## Two modes, every agent

- **Native** (default): the agent's real terminal UI opens for the host —
  prompts, pickers, permission dialogs, everything untouched. Teammates'
  instructions are typed visibly into its prompt box.
- **Headless** (`--headless`): Collagent's own feed UI drives the agent
  programmatically. Useful on servers or when you don't want the agent UI to
  own your terminal. Headless modes auto-approve agent actions — only invite
  people you trust with the host machine.

Check what's installed:

```
collagent agents
```
