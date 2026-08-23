# Collagent docs site

Standalone documentation website — Markdown in `content/`, static HTML out.

```
npm run docs:build     # content/ → dist/  (zero dependencies)
npm run docs:dev       # build + serve on http://127.0.0.1:7780
```

`dist/` is fully static: deploy it to any static host (e.g. docs.collagent.ai).
The Collagent server also serves it at `/docs` as a local fallback, and the
dashboard's "Docs ↗" link points at `COLLAGENT_DOCS_URL` (default `/docs/`).

- Navigation lives in `build.mjs` (`NAV`) — add a page there and in `content/`.
- Images go in `public/images/` and are copied into `dist/` verbatim.
- `test/docs-site.test.js` verifies every documented `collagent` command
  exists in the CLI, and every CLI command is documented.
