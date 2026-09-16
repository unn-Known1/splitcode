# AGENTS.md — instructions for AI coding agents working on SplitCode

## What this is
SplitCode (`split-js.js`) splits one large classic-script JS file into
smaller dependency-ordered files via pure static analysis (acorn, no LLM).
Single-file CLI, one runtime dependency (`acorn`).

## Commands
- Install: `npm install` (only needs `acorn`)
- Syntax check: `node --check split-js.js`
- Run: `node split-js.js <input.js> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader app.js | --no-loader]`
- Tarball check: `npm pack --dry-run` (must stay minimal — code + docs only)

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
