# Changelog

## 0.3.0 — 2026-09-24

Drop-in replacement release: the split output must be able to **replace the
original file** with the host app behaving identically (see AGENTS.md
"Drop-in contract"). Plus startup/install performance and safety.

### Safety (previously data loss, all reproduced before the fix)

- Refuse to overwrite the input file itself (outDir == input dir + loader
  collision) unless `--force`; the input is never deleted, even with `--force`.
- Stale cleanup is manifest-tracked + name-precise — it only removes files
  the tool emitted. It no longer deletes unrelated `*.js`/`*.ts`/`*.py`
  files in outDir, and refuses foreign-name collisions unless `--force`.
- `--check` no longer needs outDir and never writes (previously
  `splitcode app.js --check` created a `./--check/` directory with a full split).
- New `--force` (allow the above) and `--dry-run` (plan, write nothing).

### Correctness (previously silently wrong output, exit 0)

- Duplicate declarations: order + cluster edges now link to **every**
  same-name declaration. The `dup` last-wins probe
  (`function dup(){return 1} / function dup(){return 2} /
  console.log(dup())`) prints `2` under real per-file loading (was `1`).
- ESM inputs (`parserMode: "module"`) now get `<script type="module">`
  loader/tags instead of classic tags that throw at runtime.
- New `--loader-mode inline`: self-contained loader with all parts
  concatenated in order (no `document.write`, no extra requests).
- New preflight codes (JS): `indirect-eval`, `string-callback`,
  `cjs-require`, `dynamic-global-key`, `prototype-methods`,
  `implicit-global`; (TS): `indirect-eval`, `string-callback`,
  `cjs-require`, `prototype-methods`. Extended `import-scripts` to member
  form (`self.importScripts`). A 9-pattern evasive fixture went from
  "clean" to 5 warnings + 2 notes.
- New `--strict`: refuse to write when preflight warns (exit 2).
  Exit codes documented: 0 success · 1 error · 2 risky.
- HTML rewrite is span-splicing now: only processed inline blocks are
  touched, other page bytes preserved verbatim (was `<hr/>` → `<hr>` etc.).
- Manifest gains `tool`, `toolVersion`, `schemaVersion`, `loaderMode`,
  `strict`, `hubThreshold`, `input{file,bytes,statements,sha256}`,
  `output{statements,bytes}` (all additive — old readers keep working).
- `toKebab` empty-base fallback (`section-N`) + 80-char filename cap.
- Friendly errors (no stacks) for missing input, unparseable files
  (preflight findings shown), oversized input (`--max-bytes`, default 32MB),
  and missing optional `typescript`.

### Performance

- Startup 713ms → ~118ms for JS runs (`typescript`/`node-html-parser`
  now lazy; `typescript` moved to `optionalDependencies`).
- Every input is parsed once, not 2–3× (shared AST caches; Python warns
  merged into `pyfacts.py` — one `python3` spawn, was two; full Python run
  1.59s → 0.59s).
- Kahn ordering is a binary heap (3 000 clusters: 536ms → ~10ms);
  Louvain uses integer-key weights; Tarjan adjacency hoisted;
  `chars()` sizes precomputed; comment attach is a single sweep;
  Python offset mapping precomputed per line.
- Content-hash skip: unchanged files aren't rewritten on reruns.

### DX / packaging

- `npm test` (30 checks incl. per-file behavioral equivalence harness),
  `npm run bench`, `prepack` syntax gate, `engines: node>=16`.
- New flags: `--strict --force --dry-run --no-louvain --no-hubs
  --loader-mode --max-bytes --timing --quiet --help --version`;
  flags accepted before or after outDir; `--min-chars` strictly validated.
- `typescript` is optional: JS/HTML/Python installs drop from ~27MB.

## 0.2.0

- Multi-language: TS + HTML + Python frontends on shared backend.
- Preflight risk scan per file type + `--check` mode.
- Claude Skill + agent docs, GitHub Pages landing page, `llms.txt`.
