# SplitCode — Split a Large JavaScript File Into Smaller Dependency-Ordered Files

Split one giant `app.js` into clean, load-ordered modules using pure static
analysis — no bundler, no LLM, no config. SplitCode parses your JavaScript,
finds real dependencies between top-level statements, groups coupled code
together, and emits a **drop-in bootstrap loader**, so your existing
`<script>` tags keep working unchanged.

> **Keywords:** javascript splitter, split js file, break up large javascript
> file, refactor monolithic script, js code splitting without bundler,
> legacy javascript modularization, script dependency ordering.

## Why SplitCode?

- 📦 **Break up monolithic scripts** — turn a 500KB `app.js` into focused,
  reviewable files grouped by what actually depends on what.
- 🔗 **Correct load order, computed** — references that run immediately
  enforce ordering; deferred callbacks don't (so a click handler won't
  manufacture false load-order cycles).
- 🚀 **Zero-integration loader** — the generated `app.js` bootstrap pulls in
  every split file in order. Deploy the folder; change nothing else.
- 🔍 **Honest output** — `manifest.json` reports hubs, duplicates, cycles,
  and parser mode, so you see exactly how cleanly your file decomposed.

## Quick start

```bash
npm install acorn
node split-js.js app.js ./split-out
```

Deploy `./split-out` and keep loading `app.js` from your pages — the
generated loader pulls in the rest in dependency order. That's the whole
migration.

## How it works

1. **Parse** the file with `acorn` into an AST (classic scripts; ES modules
   via fallback).
2. **Collect declarations** — `function`/`class`/`var`/`let`/`const`,
   `import` bindings, plus global writes (`foo = …`, `window.foo = …`,
   `Object.assign(window, {…})`).
3. **Walk each statement** with a scope-aware free-variable collector that
   distinguishes **immediate** references (run the instant the statement
   runs — including IIFEs, `Promise` executors, and known-synchronous
   callbacks like `arr.map`/`forEach`) from **deferred** ones (callbacks
   that fire later). Block scoping (`if`/`for`/`switch`/bare `{}`) is
   respected; `var` still hoists.
4. **Cluster** tightly-coupled statements: connected-components first, then
   **Louvain modularity** refinement to cut weak bridges in oversized
   clusters. Over-shared "hub" globals (used everywhere) are excluded from
   grouping so they don't weld the file into one blob.
5. **Topologically order** the files on immediate dependencies only, then
   write each cluster out with `manifest.json`, `script-tags.html`, and the
   `app.js` bootstrap loader.

## Usage

```
node split-js.js <input.js> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader app.js | --no-loader]
```

| Option | Default | Meaning |
|---|---|---|
| `--hub-ratio` | `0.12` | Names referenced by more than this fraction of statements are treated as shared app state, not a clustering signal. |
| `--min-chars` | `400` | Clusters smaller than this merge into their neighbour, avoiding a pile of one-line files. |
| `--loader app.js` | on | Writes a bootstrap loader named `app.js` into `outDir`. Keep loading just that ONE file — it pulls in the split files in order. Load it with a plain `<script src>`, not async/defer. |
| `--no-loader` | — | Disables the loader; paste `script-tags.html` into your page instead. |

## Proven on a real 460KB app (671 top-level statements)

- 671 statements in → 671 out. Nothing lost or duplicated (input checksum
  verified unchanged after the run).
- Reassembled output passes `node --check` (syntax only — smoke-test split
  pages for behavior).
- 18 files, largest 95 statements; no load-order cycles; zero ordering
  violations; 1 hub suppressed (`toast`); 1 duplicate declaration reported
  (`showTabEditor` — refs resolve to the first).

## Honest limitations

- An *unknown* receiver's callback defaults to deferred (`arr.map(fn)` is
  covered; a custom `runNow(fn)` is not) — the general case is undecidable
  by syntax analysis. Keep synchronously-coupled code together or verify order.
- Heavy shared mutable state genuinely merges files — the tool can't invent
  boundaries that don't exist. Check `hubNamesSuppressed` and cluster sizes.
- `manifest.json` carries `"verified": "syntax-only"` as a reminder of what
  was (and wasn't) proven.

## Requirements

- Node.js ≥ 16, plus `acorn` (`npm install acorn`).

## License

MIT — do what you want, no warranty. Static analysis can miss dynamic
edges; smoke-test split pages before shipping.

## Author

**unn-Known1** — ptelgm.yt@gmail.com
([github.com/unn-Known1](https://github.com/unn-Known1))
