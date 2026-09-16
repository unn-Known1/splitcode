# SplitCode — Split Large JS, TS, HTML or Python Files Into Dependency-Ordered Pieces

[![npm (coming soon)](https://img.shields.io/badge/npm-coming_soon-blue)](https://www.npmjs.com/package/splitcode)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/unn-Known1/splitcode/blob/master/LICENSE)

Split one giant `app.js` / `app.ts` / page / `app.py` into clean,
load-ordered modules using pure static analysis — no bundler, no LLM, no
config. SplitCode parses your code, finds real dependencies between
top-level statements, groups coupled code together, and emits a **drop-in
bootstrap loader**, so existing entry points keep working unchanged.

> **Keywords:** javascript splitter, split js file, typescript splitter,
> split python file, refactor monolithic script, js code splitting without
> bundler, legacy code modularization, script dependency ordering.

## Why SplitCode?

- 📦 **Break up monolithic scripts** — turn a giant `app.js` into focused,
  reviewable files grouped by what actually depends on what.
- 🔗 **Correct load order, computed** — references that run immediately
  enforce ordering; deferred callbacks don't (so a click handler won't
  manufacture false load-order cycles).
- 🚀 **Zero-integration loader** — the generated `app.js` bootstrap pulls in
  every split file in order. Deploy the folder; change nothing else.
- 🔍 **Honest output** — `manifest.json` reports hubs, duplicates, cycles,
  and parser mode, so you see exactly how cleanly your file decomposed.

## Quick start

> **npm release pending** — `npx`/`-g` commands below work once `splitcode`
> is published. Until then, use the from-source form (identical behavior).

```bash
# once published (no install needed):
npx splitcode app.js ./split-out

# or install globally:
npm install -g splitcode
splitcode app.js ./split-out
```

From source today (same thing — `splitcode` is just the `bin` alias for
`split-js.js`):

```bash
npm install acorn
node split-js.js app.js ./split-out
```

Deploy `./split-out` and keep loading `app.js` from your pages — the
generated loader pulls in the rest in dependency order. That's the whole
migration.

## For AI agents

Paste this into your project's `CLAUDE.md` / `AGENTS.md` so agents split
before they read:

> For files over ~100KB: run `npx splitcode <file> ./split-out` first, plan
> from `./split-out/manifest.json`, edit per-file, never reorder `order`,
> test after every change.

A ready-made Claude Skill lives at `skills/splitcode/SKILL.md` — copy it
into your project's `.claude/skills/` (or global skills dir) and agents
will invoke it automatically when files get large. Agent-readable docs:
`docs/llms.txt` (also served at `/llms.txt` on the site).

## How it works

1. **Parse** the file with `acorn` into an AST (classic scripts; ES modules
   via fallback).
2. **Collect declarations** — `function`/`class`/`var`/`let`/`const`,
   `import` bindings, plus global writes (`foo = …`, `window.foo = …`,
   `Object.assign(window, {…})`).
3. **Walk each statement** with a scope-aware free-variable collector that
   distinguishes **immediate** references (run the instant the statement
   runs) from **deferred** ones (callbacks that fire later). Immediate
   includes IIFEs, `fn.call`/`fn.apply`, `Promise` executors, and a
   spec-backed allowlist (`map`/`forEach`/`filter`/`every`/`some`/`find*`/
   `reduce*`/`flatMap`/`sort`, `str.replace(re, fn)`, `Array.from(it, fn)`,
   `JSON.stringify(v, fn)`). Block scoping (`if`/`for`/`switch`/bare `{}`)
   is respected; `var` still hoists; `with` bodies count every ref as live;
   `window.foo` reads link back to `window.foo = …` writes.
4. **Cluster** tightly-coupled statements: connected-components first, then
   **Louvain modularity** refinement to cut weak bridges in oversized
   clusters. Over-shared "hub" globals (used everywhere) are excluded from
   grouping so they don't weld the file into one blob.
5. **Topologically order** the files on immediate dependencies only.
   Function declarations are hoisted, so they move freely; anything that
   executes immediately (a bare call, `const x = f()`) keeps its relative
   position. On a genuine cycle the tool warns and falls back to original
   order for those clusters instead of guessing.
6. **Write the outputs** (see below): cluster files, `manifest.json`,
   `script-tags.html`, and the `app.js` bootstrap loader.

## Usage

```
splitcode <input.(js|ts|html|py)> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader <name> | --no-loader] [--lang js|ts|html|py]
# from source: node split-js.js <same args>
```

| Option | Default | Meaning |
|---|---|---|
| `--hub-ratio` | `0.12` | Names referenced by more than this fraction of statements are treated as shared app state, not a clustering signal. |
| `--min-chars` | `400` | Clusters smaller than this merge into their neighbour, avoiding a pile of one-line files. |
| `--loader app.js` | on | Writes a bootstrap loader named `app.js` into `outDir`. Keep loading just that ONE file — it pulls in the split files in order. Load it with a plain `<script src>`, not async/defer. Rename with `--loader bootstrap.js`; a cluster that would collide gets suffixed (`app-2.js`). |
| `--no-loader` | — | Disables the loader; paste `script-tags.html` into your page instead (JS/TS/HTML; Python has no tags file). |
| `--lang js\|ts\|html\|py` | auto (extension) | Force the frontend for extension-less or oddly-named inputs. |

## Languages

Dispatch is by file extension (override with `--lang js|ts|html|py`).
One shared backend clusters, orders and names — each language gets a
frontend plus its own loader.

| Input | Frontend | Output | Loader |
|---|---|---|---|
| `.js` / `.mjs` / `.cjs` | `acorn` AST, full scope analysis | `.js` parts | `app.js` — synchronous `document.write` bootstrap, keep loading just it |
| `.ts` / `.tsx` | `typescript@5` API (v6+/native port has no JS AST API — pinned `^5.9`) | `.ts` parts (types kept) | same mechanism, `.ts` file |
| `.html` | pools every inline classic `<script>`; external `src` untouched | rewritten page + `.js` parts | loader tag inserted at the first inline block's position |
| `.py` | `python3` stdlib `ast` (requires python3 on PATH) | `.py` parts | `app.py` bootstrap — `exec`s parts in order in **shared globals**, so module names behave exactly as one file |

TypeScript specifics: type-position refs (`: Foo`, `implements Bar`) cluster
but never order (erased at runtime); decorators/enum initializers/namespace
bodies/static blocks are immediate; field initializers are deferred
(construction time); `<Foo />` tags count as refs.
HTML specifics: `type="module"` / non-JS blocks (ld+json) and unparseable
blocks are left in place (warned); an external `src` script *between* inline
blocks can't be ordered against the pool (warned as `externalInterleave`).
Python specifics: `def`-time evaluations (decorators, defaults,
annotations, bases) are immediate; class bodies run at creation; methods
can't see class-scope names (real Python scoping). `__name__ ==
"__main__"` blocks run exactly as before; caveat: `__file__` inside a part
points at the bootstrap. Behavioral check: original vs split stdout
diffed — identical (modulo independent-print interleaving, see limitations).

## Outputs (`outDir`)

- **Cluster files** — named after their most-used declaration in kebab-case
  (`auth-token.js`), `section-N.js` fallback. Each carries a
  `// Declares: …` header comment.
- **Loader (`app.js`)** — resolves its own directory and injects the split
  files synchronously via `document.write` during parsing (the only
  single-file mechanism with `<script>`-tag semantics). Caveat: Chrome may
  block `document.write`-injected scripts on very slow (2G) connections —
  use `script-tags.html` then.
- **`manifest.json`** — machine-readable result:

  | Field | Meaning |
  |---|---|
  | `order` | Files with `declares` + `statementCount`, in load order |
  | `loader` | Entry-point file name (`null` with `--no-loader`) |
  | `hubNamesSuppressed` | Shared-everywhere globals excluded from grouping |
  | `cycleFallback` | Whether any cluster group fell back to original order |
  | `parserMode` | `script`, or `module` if the ESM fallback parsed it |
  | `duplicateDeclarations` | Repeated top-level names (refs use the first) |
  | `verified` | Always `"syntax-only"` — what was (and wasn't) proven |

- **`script-tags.html`** — paste-in alternative to the loader.

## Hygiene (automatic)

- **Stale cleanup** — reruns delete previous tool output (`*.js`,
  `manifest.json`, `script-tags.html`) from `outDir` first, so orphaned
  files from a different cluster count can't linger.
- **CLI validation** — bad `--hub-ratio`/`--min-chars` values and unknown
  flags exit with an error instead of silently becoming `NaN`.
- **Duplicate declarations** — legal `var`/`function` redeclarations warn on
  console and in the manifest; references resolve to the first.

## Proven on a real 460KB app (671 top-level statements)

- 671 statements in → 671 out. Nothing lost or duplicated (input checksum
  verified unchanged after the run).
- Reassembled output passes `node --check` (syntax only — smoke-test split
  pages for behavior).
- 18 files, largest 95 statements; no load-order cycles; zero ordering
  violations; 1 hub suppressed (`toast`); 1 duplicate declaration reported
  (`showTabEditor` — refs resolve to the first).

## Honest limitations

- **Side-effect order across files.** Order is enforced only along
  dependency edges. Two top-level statements with side effects (prints, DOM
  writes) but no shared names may run in a different relative order after
  splitting — demonstrated by test: independent `print` lines swapped files.
  If exact interleaving matters, keep those statements coupled (shared name)
  or in one file.
- An *unknown* receiver's callback defaults to deferred (`arr.map(fn)` is
  covered; a custom `runNow(fn)` is not) — the general case is undecidable
  by syntax analysis. Keep synchronously-coupled code together or verify order.
- Dynamic global keys (`window[x] = …`) can't be tracked statically and are
  skipped.
- Heavy shared mutable state genuinely merges files — the tool can't invent
  boundaries that don't exist. Check `hubNamesSuppressed` and cluster sizes.
- `manifest.json` carries `"verified": "syntax-only"` as a reminder of what
  was (and wasn't) proven.

## Requirements

- Node.js ≥ 16.
- JS/HTML: `acorn` + `node-html-parser` (`npm install`).
- TS: `typescript@5` (`npm install` pulls `^5.9`; v6+/native has no JS AST API).
- Python: `python3` on PATH (stdlib `ast` only — no pip packages).

## License

MIT — do what you want, no warranty. Static analysis can miss dynamic
edges; smoke-test split pages before shipping.

## Author

**unn-Known1** — ptelgm.yt@gmail.com
([github.com/unn-Known1](https://github.com/unn-Known1))
