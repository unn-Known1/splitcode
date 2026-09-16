---
name: splitcode
description: Split a large JS, TS, HTML or Python file into smaller dependency-ordered files before reading or refactoring it. Use whenever a source file exceeds ~100KB, context budget matters, or a monolith (app.js, bundle, legacy script) must be broken up. Runs one deterministic command with zero file reading, then work from manifest.json.
---

# SplitCode skill

Split the monolith FIRST, read SECOND. Never read a >100KB file whole.

## 1. Split (blind — do not open the file)

```bash
npx splitcode <file> ./split-out
# from source: node split-js.js <file> ./split-out
# extensions: .js .ts .tsx .html .py (or --lang js|ts|html|py)
# Python needs python3 on PATH
```

Same input always yields same output — safe to run without reading anything.

## 2. Plan from `./split-out/manifest.json` alone

```json
{ "order": [{ "file": "...", "declares": [...], "statementCount": 0 }],
  "loader": "app.js", "hubNamesSuppressed": [],
  "cycleFallback": false, "duplicateDeclarations": [],
  "verified": "syntax-only" }
```

- `order` IS the load order. `declares` tells you what lives where.
- `hubNamesSuppressed` = shared state touched everywhere (edit carefully).
- Open only the files your task needs. Nothing else.

## 3. Rules (non-negotiable)

1. NEVER reorder `order`, NEVER rename the loader.
2. Rerun the project's tests after EVERY edit.
3. `"verified": "syntax-only"` proves syntax, NOT behavior — you own the smoke test.
4. Side-effecting statements with no shared names may interleave differently across files; if exact order matters, keep them coupled.
5. Unknown-receiver callbacks default to deferred — a missed edge warns nothing. When unsure, keep synchronously-coupled code in one file.

## 4. Entry points

- Web pages keep loading just the loader (`app.js`); Python keeps running `app.py`. Change nothing else.
- Flags (all optional): `[--hub-ratio 0.12] [--min-chars 400] [--loader <name> | --no-loader]`

## Limits to respect

Dynamic keys (`window[x] = ...`), `export *`, star imports: untracked.
Duplicates resolve to the first declaration. `__file__` in Python parts
points at the bootstrap. External `<script src>` between HTML inline blocks
can't be ordered. Chrome may block document.write loaders on 2G.
