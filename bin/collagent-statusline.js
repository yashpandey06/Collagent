#!/usr/bin/env node
/**
 * Claude Code status line for shared sessions (registered via --settings).
 * Renders one line at the bottom of the native Claude Code UI:
 *
 *   ⧉ collagent 7FK2P · ●Alice* ●Bob · working · invite: collagent join 7FK2P
 *
 * argv[2] = session status API url, argv[3] = session code (fallback label).
 * Claude Code re-runs this as the session changes, so presence stays live.
 */
const [, , apiUrl, code = ''] = process.argv;

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(900) });
    const s = await res.json();
    const people = s.participants
      .map((p) => `${p.connected ? '●' : '○'}${p.name}${p.id === s.driverId ? '*' : ''}`)
      .join(' ');
    const mode = s.mode === 'driver' ? ' · driver-mode' : '';
    process.stdout.write(
      `⧉ collagent ${s.code} · ${people} · ${s.status}${mode} ${dim(`· invite: collagent join ${s.code}`)}`,
    );
  } catch {
    process.stdout.write(`⧉ collagent ${code} ${dim('(session server unreachable)')}`);
  }
  process.exit(0);
});
