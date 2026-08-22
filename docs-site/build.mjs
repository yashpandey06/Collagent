#!/usr/bin/env node
/**
 * Collagent docs site generator — zero dependencies.
 *
 *   node docs-site/build.mjs           build content/ → dist/
 *   node docs-site/build.mjs --serve   build, then serve dist/ on :7780
 *
 * dist/ is fully static and deploys anywhere (docs.collagent.ai). The
 * Collagent server also serves it at /docs as a local fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(ROOT, 'content');
const PUBLIC = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

/** Navigation is the site's source of truth: group → [file, sidebar title]. */
export const NAV = [
  ['Get Started', [
    ['index.md', 'Introduction'],
    ['get-started/installation.md', 'Installation'],
    ['get-started/quickstart.md', 'Quickstart'],
    ['get-started/first-room.md', 'First Room'],
  ]],
  ['Using Collagent', [
    ['using/rooms.md', 'Rooms'],
    ['using/joining.md', 'Joining a Room'],
    ['using/live-sessions.md', 'Live Sessions'],
    ['using/participants.md', 'Participants'],
    ['using/history-catchup.md', 'History & Catch Up'],
    ['using/handoff.md', 'Handoff'],
    ['using/pause-resume.md', 'Pause & Resume'],
    ['using/remote.md', 'Remote / Network Usage'],
  ]],
  ['Agents', [
    ['agents/index.md', 'Overview'],
    ['agents/claude-code.md', 'Claude Code'],
    ['agents/codex.md', 'Codex'],
    ['agents/cursor.md', 'Cursor'],
    ['agents/gemini-cli.md', 'Gemini CLI'],
    ['agents/goose.md', 'Goose'],
    ['agents/opencode.md', 'OpenCode'],
  ]],
  ['Multi-Agent', [
    ['multi-agent/add-agent.md', 'Add an Agent'],
    ['multi-agent/working.md', 'Working With Multiple Agents'],
    ['multi-agent/addressing.md', 'Addressing an Agent'],
    ['multi-agent/agent-handoff.md', 'Agent Handoff'],
    ['multi-agent/cross-agent.md', 'Cross-Agent Collaboration'],
  ]],
  ['Commands', [
    ['commands/cli.md', 'CLI Reference'],
    ['commands/room.md', 'Room Commands'],
  ]],
];

// ---- markdown → html ---------------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
      if (/^https?:\/\//.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
      return `<a href="${href.replace(/\.md(#|$)/, '.html$1')}">${text}</a>`;
    });
}

export function renderMarkdown(src) {
  const lines = src.split('\n');
  const out = [];
  const headings = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push('<div class="codeblock"><pre><code>' + esc(buf.join('\n')) + '</code></pre>'
        + '<button class="copy" type="button" aria-label="copy to clipboard">Copy</button></div>');
      continue;
    }
    if (/^#{1,4} /.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const text = line.replace(/^#+ /, '');
      const id = slug(text);
      if (level >= 2 && level <= 3) headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(esc(text))}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      let html = '<table><tr>' + cells(rows[0]).map((c) => '<th>' + inline(esc(c)) + '</th>').join('') + '</tr>';
      for (const row of rows.slice(2)) html += '<tr>' + cells(row).map((c) => '<td>' + inline(esc(c)) + '</td>').join('') + '</tr>';
      out.push(html + '</table>');
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) {
        let item = lines[i++].replace(/^\s*[-*] /, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*] /.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push('<li>' + inline(esc(item)) + '</li>');
      }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        let item = lines[i++].replace(/^\d+\. /, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push('<li>' + inline(esc(item)) + '</li>');
      }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }
    if (/^> /.test(line)) {
      const buf = [];
      while (i < lines.length && /^> ?/.test(lines[i])) buf.push(lines[i++].replace(/^> ?/, ''));
      out.push('<blockquote><p>' + inline(esc(buf.join(' '))) + '</p></blockquote>');
      continue;
    }
    if (/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.test(line)) {
      const [, alt, href] = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
      out.push(`<img src="${href}" alt="${esc(alt)}" loading="lazy">`);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#|```|\s*[-*] |\d+\. |> |\s*\||---|!\[)/.test(lines[i])) buf.push(lines[i++]);
    out.push('<p>' + inline(esc(buf.join(' '))) + '</p>');
  }
  return { html: out.join('\n'), headings };
}

// ---- site assembly -------------------------------------------------------------

const FLAT = NAV.flatMap(([group, pages]) => pages.map(([file, title]) => ({ group, file, title })));
const outPath = (file) => file.replace(/\.md$/, '.html');
const depthPrefix = (file) => '../'.repeat(file.split('/').length - 1);

function sidebar(activeFile, prefix) {
  let html = '';
  for (const [group, pages] of NAV) {
    html += `<div class="grp">${esc(group)}</div>`;
    for (const [file, title] of pages) {
      const cls = file === activeFile ? ' class="on"' : '';
      html += `<a href="${prefix}${outPath(file)}"${cls}>${esc(title)}</a>`;
    }
  }
  return html;
}

function pageShell({ file, title, group, bodyHtml, headings }) {
  const prefix = depthPrefix(file);
  const toc = headings.length >= 3
    ? '<nav class="toc"><div class="grp">On this page</div>'
      + headings.map((h) => `<a href="#${h.id}" class="d${h.level}">${esc(h.text)}</a>`).join('') + '</nav>'
    : '';
  const crumbs = group === 'Get Started' && file === 'index.md'
    ? 'Docs'
    : `Docs <span>/</span> ${esc(group)} <span>/</span> ${esc(title)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Collagent Docs</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cg stroke='%23ff875f' stroke-width='1.8'%3E%3Cpath d='M12 13 5.5 5M12 13l6.5-8M12 13v8'/%3E%3C/g%3E%3Ccircle cx='5.5' cy='5' r='2.4' fill='%23e6e6ea'/%3E%3Ccircle cx='18.5' cy='5' r='2.4' fill='%23e6e6ea'/%3E%3Ccircle cx='12' cy='21' r='2.4' fill='%23e6e6ea'/%3E%3Ccircle cx='12' cy='13' r='3' fill='%23ff875f'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${prefix}assets/docs.css">
</head>
<body>
<header class="top">
  <a class="brand" href="${prefix}index.html">
    <svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="#ff875f" stroke-width="1.8"><path d="M12 13 5.5 5M12 13l6.5-8M12 13v8"/></g><circle cx="5.5" cy="5" r="2.4" fill="currentColor"/><circle cx="18.5" cy="5" r="2.4" fill="currentColor"/><circle cx="12" cy="21" r="2.4" fill="currentColor"/><circle cx="12" cy="13" r="3" fill="#ff875f"/></svg>
    <b>collagent</b> <span>docs</span>
  </a>
  <div class="search"><input id="search" type="search" placeholder="Search docs…" autocomplete="off"><div id="results"></div></div>
  <button id="theme" type="button" aria-label="toggle theme">◐</button>
</header>
<div class="layout">
  <nav class="side">${sidebar(file, prefix)}</nav>
  <main>
    <div class="crumbs">${crumbs}</div>
    <article>${bodyHtml}</article>
  </main>
  ${toc}
</div>
<script>window.__prefix=${JSON.stringify(prefix)};</script>
<script src="${prefix}assets/docs.js"></script>
</body>
</html>`;
}

export function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });

  const searchIndex = [];
  for (const { group, file, title } of FLAT) {
    const src = fs.readFileSync(path.join(CONTENT, file), 'utf8');
    const { html, headings } = renderMarkdown(src);
    const out = path.join(DIST, outPath(file));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pageShell({ file, title, group, bodyHtml: html, headings }));
    searchIndex.push({
      url: outPath(file),
      title,
      group,
      text: src.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*`|\[\]()-]/g, ' ').replace(/\s+/g, ' ').slice(0, 800),
    });
  }
  fs.writeFileSync(path.join(DIST, 'assets', 'search-index.json'), JSON.stringify(searchIndex));
  fs.writeFileSync(path.join(DIST, 'assets', 'docs.css'), CSS);
  fs.writeFileSync(path.join(DIST, 'assets', 'docs.js'), JS);
  if (fs.existsSync(PUBLIC)) fs.cpSync(PUBLIC, DIST, { recursive: true });
  return FLAT.length;
}

// ---- theme ------------------------------------------------------------------------

const CSS = `
:root {
  color-scheme: dark;
  --bg:#101014; --panel:#16161c; --panel2:#1a1a21;
  --ink:#e6e6ea; --dim:#a4a4af; --faint:#5c5c66; --line:#26262e;
  --accent:#ff875f; --accent-ink:#1a120d; --ok:#5ad48a;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
html[data-theme="light"] {
  color-scheme: light;
  --bg:#faf8f5; --panel:#ffffff; --panel2:#f1eee8;
  --ink:#211f1c; --dim:#5f5c55; --faint:#a29d92; --line:#e6e1d7;
  --accent:#d4551f; --accent-ink:#fff; --ok:#1e7c47;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.7 var(--sans); transition:background .25s,color .25s; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }

.top { display:flex; align-items:center; gap:18px; padding:10px 22px; border-bottom:1px solid var(--line);
       position:sticky; top:0; background:var(--bg); z-index:10; }
.brand { display:flex; align-items:center; gap:9px; color:var(--ink); font-family:var(--mono); font-size:14px; }
.brand:hover { text-decoration:none; }
.brand svg { width:18px; height:18px; }
.brand span { color:var(--faint); }
.search { position:relative; margin-left:auto; }
.search input { font:13px var(--mono); color:var(--ink); background:var(--panel2); border:1px solid var(--line);
                border-radius:6px; padding:6px 12px; width:230px; }
.search input:focus-visible { outline:1.5px solid var(--accent); outline-offset:1px; }
#results { position:absolute; top:38px; right:0; width:340px; background:var(--panel); border:1px solid var(--line);
           border-radius:8px; display:none; max-height:340px; overflow-y:auto; box-shadow:0 10px 30px rgba(0,0,0,.25); }
#results a { display:block; padding:9px 13px; border-bottom:1px solid var(--line); color:var(--ink); font-size:13px; }
#results a:last-child { border-bottom:0; }
#results a:hover, #results a.sel { background:var(--panel2); text-decoration:none; }
#results a small { display:block; color:var(--faint); font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; }
#theme { font:14px var(--mono); color:var(--faint); background:none; border:0; cursor:pointer; }
#theme:hover { color:var(--dim); }

.layout { display:grid; grid-template-columns:230px minmax(0,720px) 200px; gap:0 44px; max-width:1240px; margin:0 auto; padding:0 22px; }
@media (max-width:1080px) { .layout { grid-template-columns:230px minmax(0,1fr); } .toc { display:none; } }
@media (max-width:760px) { .layout { grid-template-columns:1fr; } .side { display:none; } }

.side { padding:26px 0 80px; border-right:1px solid var(--line); position:sticky; top:53px; height:calc(100vh - 53px); overflow-y:auto; }
.side .grp, .toc .grp { font:600 10.5px var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--faint); margin:18px 0 5px; }
.side .grp:first-child { margin-top:0; }
.side a { display:block; color:var(--dim); font-size:13.5px; padding:4px 10px 4px 12px; border-left:2px solid transparent;
          border-radius:0 5px 5px 0; transition:color .12s, background .12s; }
.side a:hover { color:var(--ink); background:var(--panel2); text-decoration:none; }
.side a.on { color:var(--accent); border-left-color:var(--accent); background:var(--panel2); }

main { padding:26px 0 110px; }
.crumbs { font:12px var(--mono); color:var(--faint); margin-bottom:18px; }
.crumbs span { padding:0 6px; }

article h1 { font-size:26px; line-height:1.25; margin:0 0 10px; letter-spacing:-.01em; }
article h2 { font-size:17px; margin:34px 0 8px; padding-top:14px; border-top:1px solid var(--line); }
article h3 { font-size:14.5px; margin:22px 0 6px; }
article p, article li { color:var(--dim); max-width:70ch; }
article li { margin:3px 0; }
article strong { color:var(--ink); }
article blockquote { border-left:3px solid var(--accent); margin:12px 0; padding:2px 16px; }
article blockquote p { color:var(--ink); }
article hr { border:0; border-top:1px solid var(--line); margin:26px 0; }
article img { max-width:100%; border:1px solid var(--line); border-radius:8px; }
article code { font:.86em var(--mono); color:var(--ink); background:var(--panel2); border:1px solid var(--line); border-radius:4px; padding:.08em .38em; }
article table { border-collapse:collapse; width:100%; font-size:13.5px; margin:12px 0; }
article th { text-align:left; font:600 10.5px var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--faint);
             padding:7px 11px; border-bottom:1px solid var(--line); }
article td { padding:7px 11px; border-bottom:1px solid var(--line); color:var(--dim); vertical-align:top; }
article td:first-child { color:var(--ink); font-family:var(--mono); font-size:12.5px; white-space:nowrap; }

.codeblock { position:relative; margin:12px 0; }
.codeblock pre { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:13px 15px;
                 overflow-x:auto; font:12.5px/1.6 var(--mono); color:var(--ink); margin:0; }
.codeblock .copy { position:absolute; top:8px; right:8px; font:11px var(--mono); color:var(--dim);
                   background:var(--panel2); border:1px solid var(--line); border-radius:5px; padding:3px 9px;
                   cursor:pointer; opacity:0; transition:opacity .15s, color .15s, border-color .15s; }
.codeblock:hover .copy, .codeblock .copy:focus-visible { opacity:1; }
.codeblock .copy:hover { border-color:var(--accent); color:var(--ink); }
.codeblock .copy.ok { color:var(--ok); border-color:var(--ok); opacity:1; }

.toc { padding:26px 0; position:sticky; top:53px; height:calc(100vh - 53px); overflow-y:auto; font-size:12.5px; }
.toc a { display:block; color:var(--faint); padding:2.5px 0; }
.toc a.d3 { padding-left:12px; }
.toc a:hover { color:var(--ink); text-decoration:none; }
@media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
`;

const JS = `
'use strict';
// theme
let theme = null;
try { theme = localStorage.getItem('collagent.theme'); } catch {}
if (theme === 'light') document.documentElement.dataset.theme = 'light';
document.getElementById('theme').onclick = () => {
  const light = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = light ? 'light' : '';
  try { localStorage.setItem('collagent.theme', light ? 'light' : 'dark'); } catch {}
};

// copy buttons — every runnable block is one click away
for (const btn of document.querySelectorAll('.codeblock .copy')) {
  btn.onclick = async () => {
    const text = btn.parentElement.querySelector('code').innerText;
    try { await navigator.clipboard.writeText(text); } catch { return; }
    btn.textContent = '\\u2713 Copied';
    btn.classList.add('ok');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1400);
  };
}

// search
const input = document.getElementById('search');
const results = document.getElementById('results');
let index = null;
input.addEventListener('focus', async () => {
  index ??= await (await fetch(window.__prefix + 'assets/search-index.json')).json();
});
input.addEventListener('input', () => {
  const q = input.value.trim().toLowerCase();
  results.innerHTML = '';
  if (!q || !index) { results.style.display = 'none'; return; }
  const hits = index
    .map((p) => ({ p, score: (p.title.toLowerCase().includes(q) ? 2 : 0) + (p.text.toLowerCase().includes(q) ? 1 : 0) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  for (const { p } of hits) {
    const a = document.createElement('a');
    a.href = window.__prefix + p.url;
    const small = document.createElement('small');
    small.textContent = p.group;
    a.appendChild(small);
    a.appendChild(document.createTextNode(p.title));
    results.appendChild(a);
  }
  results.style.display = hits.length ? 'block' : 'none';
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.style.display = 'none'; });
input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; results.style.display = 'none'; input.blur(); } });
`;

// ---- cli ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pages = build();
  console.log(`built ${pages} pages → docs-site/dist/`);
  if (process.argv.includes('--serve')) {
    const port = 7780;
    http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let file = path.join(DIST, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
      if (url.pathname === '/' || url.pathname === '') file = path.join(DIST, 'index.html');
      if (!file.startsWith(DIST)) { res.writeHead(404); return res.end(); }
      try {
        const body = fs.readFileSync(file);
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css'
          : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    }).listen(port, '127.0.0.1', () => console.log(`docs at http://127.0.0.1:${port}/`));
  }
}
