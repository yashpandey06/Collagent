import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NAV, build, renderMarkdown } from '../docs-site/build.mjs';

const CONTENT = path.join(process.cwd(), 'docs-site', 'content');

// Ground truth: the CLI dispatcher and the room-command set.
const CLI_COMMANDS = new Set([
  'serve', 'dev', 'create', 'open', 'add', 'agents', 'agent', 'rooms', 'room', 'ls',
  'join', 'invite', 'status', 'leave', 'delete', 'rm', 'help',
]);
const ROOM_COMMANDS_FILE = fs.readFileSync('src/ui/tui.js', 'utf8');

test('every page in the nav exists, renders, and every docs command is real', () => {
  const flat = NAV.flatMap(([, pages]) => pages.map(([file]) => file));
  assert.ok(flat.length >= 25, `nav has ${flat.length} pages`);

  for (const file of flat) {
    const full = path.join(CONTENT, file);
    assert.ok(fs.existsSync(full), `missing content file: ${file}`);
    const src = fs.readFileSync(full, 'utf8');
    const { html } = renderMarkdown(src);
    assert.ok(html.includes('<h1'), `${file} has a title`);

    // Docs↔code sync: any `collagent <sub>` in the docs must be a real command.
    for (const [, sub] of src.matchAll(/collagent\s+([a-z]+)\b/g)) {
      assert.ok(CLI_COMMANDS.has(sub), `${file} documents unknown command "collagent ${sub}"`);
    }
    // …and any /command in a code block or table must exist in the room TUI
    // (or be an agent passthrough example, which the TUI forwards anyway).
    for (const [, cmd] of src.matchAll(/^[|`\s>]*\/([a-z]+)\b/gm)) {
      const known = ROOM_COMMANDS_FILE.includes(`'${cmd}'`) || ['model', 'compact'].includes(cmd);
      assert.ok(known, `${file} documents unknown room command "/${cmd}"`);
    }
  }
});

test('every CLI command is documented in the reference', () => {
  const ref = fs.readFileSync(path.join(CONTENT, 'commands', 'cli.md'), 'utf8');
  for (const cmd of ['create', 'join', 'invite', 'open', 'add', 'rooms', 'agents', 'status', 'leave', 'delete', 'serve', 'dev']) {
    assert.ok(ref.includes(`collagent ${cmd}`), `CLI reference is missing "collagent ${cmd}"`);
  }
});

test('the site builds: static pages, copy buttons, search index, assets', (t) => {
  const pages = build();
  const dist = path.join(process.cwd(), 'docs-site', 'dist');
  t.after(() => { /* keep dist — the server serves it */ });

  assert.ok(pages >= 25);
  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.match(index, /collagent create/);
  assert.match(index, /class="copy"/, 'code blocks get copy buttons');
  assert.match(index, /assets\/docs\.css/);

  const nested = fs.readFileSync(path.join(dist, 'using', 'joining.html'), 'utf8');
  assert.match(nested, /..\/assets\/docs\.css/, 'nested pages use relative asset paths');
  assert.match(nested, /class="crumbs">Docs <span>/, 'breadcrumbs render');
  assert.match(nested, /--key/, 'real option documented');

  const searchIndex = JSON.parse(fs.readFileSync(path.join(dist, 'assets', 'search-index.json'), 'utf8'));
  assert.ok(searchIndex.some((p) => p.title === 'Quickstart'));
  assert.ok(searchIndex.every((p) => p.url.endsWith('.html')));

  const js = fs.readFileSync(path.join(dist, 'assets', 'docs.js'), 'utf8');
  assert.match(js, /Copied/, 'copy feedback wired');
  assert.match(js, /dataset.theme/, 'light/dark toggle wired');
});
