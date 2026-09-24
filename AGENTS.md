# AGENTS.md — instructions for AI coding agents working on SplitCode

## What this is
SplitCode (`split-js.js`) splits one large source file (JS/TS/HTML inline
scripts/Python) into smaller dependency-ordered files via pure static
analysis (acorn / typescript API / node-html-parser / python3 stdlib `ast`,
no LLM). Single-file CLI; runtime deps: `acorn`, `node-html-parser`,
`typescript@5` (plus `python3` on PATH for `.py`).

## Commands
- Install: `npm install` (pulls `acorn` + `node-html-parser` + `typescript@5`; Python splits need `python3` on PATH)
- Syntax check: `node --check split-js.js`
- Run: `node split-js.js <input.(js|ts|html|py)> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader <name> | --no-loader] [--lang js|ts|html|py] [--check]`
- Tarball check: `npm pack --dry-run` (must stay minimal — code + docs only)

## Drop-in contract (prime directive)
The goal of every change: splitting `<input>` into `outDir/` must let the
output **replace the original file** with the host app behaving identically.
Concretely: consumers keep loading just the loader (same name as the input
by default), parts load in `manifest.json` order, and observable behavior
matches the original. Per language: JS/TS → loader + parts in dependency
order; HTML → rewritten page + loader tag at the first inline block;
Python → `app.py` bootstrap `exec`ing parts in shared globals.
Known contract-breakers (see README "Honest limitations" and
PERFORMANCE-REPORT.md §7): ESM `import`/`export` through the classic loader,
duplicate declarations (JS last-wins vs first-resolve), invisible dynamic
edges (`eval`, member-form `window.eval` / `self.importScripts`, computed
`window[x]`, `Object.assign` prototype writes, `require()`), reordered
side-effect statements with no shared names, HTML external-`src` interleave
/ `<template>` scripts, Python relative imports / `__file__` / non-UTF8
encodings.
Never weaken this contract silently: a change that widens the breakage set
must add or extend a preflight `warn` code (README table +
`docs/llms.txt`), or refuse with a friendly error / fail under `--strict` —
never exit 0 with silently different behavior.

## Before finishing any code change
1. `node --check split-js.js` (and any touched `lib/*.js`).
2. Re-run the behavioral checks: IIFE-immediate, block-scope shadowing,
   `window.X` declarations, deferred callbacks stay deferred (see README
   "Scope handling" for the cases).
3. Full-scale check: split the sample app, confirm statement conservation
   (in == out), zero ordering violations, reassembled output passes
   `node --check`.
4. Preflight check: `node split-js.js <input> <out> --check` on a risky
   sample per touched language — every new `warn`/`note` code must already
   be in the README preflight table AND `docs/llms.txt`.
5. Never modify `Test_sample_js/` fixtures (gitignored, local-only).
6. Keep `manifest.json` fields backward-compatible; document any new field
   in README.
7. New runtime file? `lib/` ships via the `files` whitelist — verify with
   `npm pack --dry-run` that it lands in the tarball (and only it does).
8. Drop-in equivalence (behavioral, not just syntax): for every touched
   language, compare ORIGINAL vs SPLIT execution, where SPLIT means the
   parts run as SEPARATE scripts in `manifest.json` order in one shared
   scope (per-file `vm.runInContext`, never one big concatenation —
   hoisting must not cross file boundaries, and concat-passing proves
   nothing). Minimum bar: the `dup` last-wins probe
   (`function dup(){return 1}` / `function dup(){return 2}` /
   `console.log(dup())` — original prints `2`) and one genuinely
   multi-file feature split must match stdout. `node --check` alone never
   proves the contract.
9. Safety: splitting must never delete or overwrite its own input (outDir
   == input dir + loader-name collision) and stale cleanup must only
   remove files the tool itself emitted (manifest-tracked, or `--force`
   gated) — never extension-globbed user files. Re-run the §7 S0 probes
   after touching output/cleanup/loader code.

## Webpage sync (mandatory)
`docs/index.html` is the public GitHub Pages landing page. **Whenever the
repo evolves, update the webpage in the same change:**
- CLI flags / defaults change → update Usage tabs + hero install command.
- New analysis capability or fix → update Features grid + "How it works"
  narrative if affected.
- Verified stats change (statements, file counts, violations) → update the
  hero counters AND the before/after table to match the latest real run.
- New output files / manifest fields → update terminal replay + manifest tab.
- New preflight warning codes → update Features grid if user-facing, and
  `docs/llms.txt` limits section.
- Product rename or positioning change → update title, meta description,
  footer, and README keywords block together.
- Never let the page advertise behavior the tool doesn't have; the page's
  claims must always be reproducible from the current code.

## Style
- Small, surgical edits; no drive-by refactors.
- Commit messages: short, imperative (`Add X`, `Fix Y`).
- Don't commit `node_modules/`, tarballs, or local test outputs.

## New files: update ignore rules (mandatory)
Whenever you create a new file in the repo, decide its fate in the same change:
- **Ships to users?** (runtime code, docs) → add to `package.json` `files`
  whitelist if it isn't auto-included, and verify with `npm pack --dry-run`.
- **Local-only?** (fixtures, samples, scratch outputs, editor configs) →
  add to `.gitignore` AND `.npmignore` so it is neither committed nor
  published. `Test_sample_js/` is the standing example: gitignored AND
  npmignored.
- **Public page asset?** (`docs/*`) → committed to git, never in the npm
  tarball (keep `.npmignore` excluding `docs/`).
- After editing either ignore file, re-verify: `git status --short` shows
  only intended files; `npm pack --dry-run` lists only intended tarball
  contents.
