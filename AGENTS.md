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
1. `node --check split-js.js`
2. Re-run the behavioral checks: IIFE-immediate, block-scope shadowing,
   `window.X` declarations, deferred callbacks stay deferred (see README
   "Scope handling" for the cases).
3. Full-scale check: split the sample app, confirm statement conservation
   (in == out), zero ordering violations, reassembled output passes
   `node --check`.
4. Never modify `Test_sample_js/` fixtures (gitignored, local-only).
5. Keep `manifest.json` fields backward-compatible; document any new field
   in README.

## Webpage sync (mandatory)
`docs/index.html` is the public GitHub Pages landing page. **Whenever the
repo evolves, update the webpage in the same change:**
- CLI flags / defaults change → update Usage tabs + hero install command.
- New analysis capability or fix → update Features grid + "How it works"
  narrative if affected.
- Verified stats change (statements, file counts, violations) → update the
  hero counters AND the before/after table to match the latest real run.
- New output files / manifest fields → update terminal replay + manifest tab.
- Product rename or positioning change → update title, meta description,
  footer, and README keywords block together.
- Never let the page advertise behavior the tool doesn't have; the page's
  claims must always be reproducible from the current code.

## Style
- Small, surgical edits; no drive-by refactors.
- Commit messages: short, imperative (`Add X`, `Fix Y`).
- Don't commit `node_modules/`, tarballs, or local test outputs.
