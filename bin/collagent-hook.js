#!/usr/bin/env node
/**
 * Claude Code hook forwarder. Registered (via --settings) for lifecycle hooks
 * on the shared session's Claude Code instance; reads the hook payload from
 * stdin and POSTs it to the local Collagent hook receiver.
 *
 * Must be fast, silent, and never fail: any output or non-zero exit could
 * alter Claude Code's behavior, and observation must never break the agent.
 */
const url = process.argv[2];

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: input || '{}',
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* never break the agent over observability */
  }
  process.exit(0);
});
