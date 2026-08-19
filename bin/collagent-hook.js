#!/usr/bin/env node
// Hook forwarder: reads the payload from stdin, POSTs it to the local receiver.
// Must be fast, silent, and never fail — output or a non-zero exit could
// alter the agent's behavior.
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
