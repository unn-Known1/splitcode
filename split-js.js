#!/usr/bin/env node
/**
 * SplitCode (split-js.js) — split large source files into smaller
 * dependency-ordered files. Purely mechanical, 100% static analysis.
 *
 * Frontends: JavaScript (.js, acorn), TypeScript (.ts/.tsx, typescript API),
 * HTML inline <script>s (.html), Python (.py, stdlib ast via python3).
 * One shared backend clusters + orders + names; each language gets its own
 * loader (JS/TS: document.write bootstrap; HTML: rewritten page + loader tag;
 * Python: exec bootstrap preserving shared globals).
 *
 * Drop-in contract: outDir/ must be able to REPLACE the original file with
 * the host app behaving identically (see AGENTS.md "Drop-in contract").
 *
 * Usage:
 *   node split-js.js <input.(js|ts|html|py)> [outDir] [flags...]
 *
 * Exit codes: 0 = success (warnings may be present unless --strict),
 * 1 = error, 2 = risky (preflight warnings under --check or --strict).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { analyzeRecords, clusterRecords, orderClusters, nameClusters } = require('./lib/backend');
const { analyzeJS } = require('./lib/frontend-js');

function toolVersion() {
  try {
    return require('./package.json').version || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

const HELP = `SplitCode ${toolVersion()} — split large JS, TS, HTML or Python files into dependency-ordered pieces.

Usage: splitcode <input.(js|ts|html|py)> [outDir] [flags...]

  outDir is required except with --check (writes nothing) or --help/--version.
  Flags may appear before or after outDir.

  --hub-ratio 0.12   Names used by more than this fraction of statements
                     (floor: >6 uses) are shared state, not grouping signal.
  --min-chars 400    Clusters smaller than this merge into their neighbour.
  --loader <name>    Bootstrap loader file name (must keep its extension).
  --no-loader        Disable the loader; use script-tags.html instead.
  --loader-mode <classic|inline>
                     classic: loader pulls in parts at runtime (default).
                     inline:  loader contains all parts concatenated in order.
  --lang js|ts|html|py  Force the frontend (default: auto by extension).
  --check            Preflight only: scan risks, print, write nothing.
                     Exit 0 = clean, 2 = risky.
  --strict           Refuse to write when preflight warns (exit 2 instead).
  --force            Allow overwriting colliding files and input-dir output.
  --dry-run          Plan everything, write nothing. outDir optional.
  --no-louvain       Skip Louvain refinement (pure connected-components).
  --no-hubs          Disable hub suppression (hub-ratio 0 can NOT do this).
  --max-bytes <n>    Refuse inputs larger than n bytes (default 33554432,
                     0 = unlimited) instead of risking OOM.
  --timing           Print per-phase milliseconds at the end.
  --quiet            Suppress info logs (warnings/errors still print).
  --help, -h         Show this help (exit 0).
  --version, -V      Show the version (exit 0).

Exit codes: 0 success · 1 error · 2 risky (--check/--strict with warnings).
The output can REPLACE the original file: keep loading just the loader.
Manifest carries "verified": "syntax-only" — smoke-test split apps.`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------- CLI (flags may appear anywhere) ----------
const FLAG_DEFS = {
  '--hub-ratio': 'value', '--min-chars': 'value', '--loader': 'value',
  '--lang': 'value', '--loader-mode': 'value', '--max-bytes': 'value',
  '--check': 'bool', '--strict': 'bool', '--force': 'bool', '--dry-run': 'bool',
  '--no-loader': 'bool', '--no-louvain': 'bool', '--no-hubs': 'bool',
  '--timing': 'bool', '--quiet': 'bool', '--help': 'bool', '--version': 'bool',
  '-h': 'bool', '-V': 'bool',
};
const rawArgs = process.argv.slice(2);
const positionals = [];
const flagArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--') { positionals.push(...rawArgs.slice(i + 1)); break; }
  if (a.startsWith('-') && FLAG_DEFS[a] !== undefined) {
    if (FLAG_DEFS[a] === 'value') {
      const raw = rawArgs[++i];
      if (raw === undefined) fail(`Missing value for ${a}.`);
      flagArgs.push([a, raw]);
    } else {
      flagArgs.push([a, true]);
    }
  } else if (a.startsWith('-')) {
    fail(`Unknown option ${JSON.stringify(a)}.\n${HELP}`);
  } else {
    positionals.push(a);
  }
}
const hasFlag = (name, alias) => flagArgs.some(([f]) => f === name || (alias && f === alias));
const flagValue = (name) => {
  const found = flagArgs.filter(([f]) => f === name).map(([, v]) => v);
  return found.length ? found[found.length - 1] : undefined; // last wins
};

if (hasFlag('--help', '-h')) { console.log(HELP); process.exit(0); }
if (hasFlag('--version', '-V')) { console.log(`splitcode ${toolVersion()}`); process.exit(0); }

const opts = {
  hubRatio: 0.12, minChars: 400, loader: undefined, lang: undefined,
  check: false, strict: false, force: false, dryRun: false,
  noLouvain: false, noHubs: false, loaderMode: 'classic',
  maxBytes: 33554432, timing: false, quiet: false,
};
const tPhase = {};
const t0total = Date.now();
function phase(name, fn) {
  const t0 = Date.now();
  const r = fn();
  tPhase[name] = Date.now() - t0;
  return r;
}

for (const [f, v] of flagArgs) {
  if (f === '--hub-ratio') {
    opts.hubRatio = parseFloat(v);
    if (!Number.isFinite(opts.hubRatio) || opts.hubRatio < 0 || opts.hubRatio > 1) {
      fail(`Invalid --hub-ratio ${JSON.stringify(v)}: expected a number between 0 and 1.`);
    }
  } else if (f === '--min-chars') {
    if (!/^\d+$/.test(String(v).trim())) {
      fail(`Invalid --min-chars ${JSON.stringify(v)}: expected a non-negative integer (no decimals, no signs).`);
    }
    opts.minChars = parseInt(v, 10);
  } else if (f === '--max-bytes') {
    if (!/^\d+$/.test(String(v).trim())) {
      fail(`Invalid --max-bytes ${JSON.stringify(v)}: expected a non-negative integer byte count (0 = unlimited).`);
    }
    opts.maxBytes = parseInt(v, 10);
  } else if (f === '--no-loader') {
    opts.loader = null;
  } else if (f === '--check') {
    opts.check = true;
  } else if (f === '--strict') {
    opts.strict = true;
  } else if (f === '--force') {
    opts.force = true;
  } else if (f === '--dry-run') {
    opts.dryRun = true;
  } else if (f === '--no-louvain') {
    opts.noLouvain = true;
  } else if (f === '--no-hubs') {
    opts.noHubs = true;
  } else if (f === '--timing') {
    opts.timing = true;
  } else if (f === '--quiet') {
    opts.quiet = true;
  } else if (f === '--loader') {
    if (!/^[^/\\]+$/.test(v) || v.length === 0) {
      fail(`Invalid --loader ${JSON.stringify(v)}: expected a plain file name (no path separators).`);
    }
    opts.loader = v;
  } else if (f === '--loader-mode') {
    if (v !== 'classic' && v !== 'inline') {
      fail(`Invalid --loader-mode ${JSON.stringify(v)}: expected "classic" or "inline".`);
    }
    opts.loaderMode = v;
  } else if (f === '--lang') {
    if (!['js', 'ts', 'html', 'py'].includes(v)) {
      fail(`Invalid --lang ${JSON.stringify(v)}: expected one of js, ts, html, py.`);
    }
    opts.lang = v;
  }
}

const info = (...args) => { if (!opts.quiet) console.log(...args); };

const [inputFile, outDirArg] = positionals;
if (positionals.length > 2) {
  fail(`Too many positional arguments: expected <input> [outDir], got ${JSON.stringify(positionals)}.\n${HELP}`);
}
if (!inputFile) {
  fail(`Missing input file.\n${HELP}`);
}
// outDir is required whenever anything might be written.
if (!outDirArg && !opts.check && !opts.dryRun) {
  fail(`Missing outDir (not needed with --check or --dry-run).\n${HELP}`);
}
const outDir = outDirArg ? path.resolve(outDirArg) : null;

// Friendly runtime gates (checked before any work, so failures read as
// guidance, not stack traces).
{
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 16) {
    fail(`SplitCode runs best on Node.js 16+ — you're on v${process.versions.node}. ` +
      `Good news: upgrading is quick (https://nodejs.org), and everything else is ready to go.`);
  }
}

let source;
try {
  const st = fs.statSync(inputFile);
  if (opts.maxBytes > 0 && st.size > opts.maxBytes) {
    fail(`Input is ${st.size} bytes, over --max-bytes ${opts.maxBytes}. ` +
      `Raise the limit (--max-bytes <n>, 0 = unlimited) or split a smaller file first.`);
  }
  source = phase('read', () => fs.readFileSync(inputFile, 'utf8'));
} catch (e) {
  if (e.code === 'ENOENT') {
    fail(`Input file not found: ${inputFile} — check the path and rerun.`);
  }
  if (e.code === 'EISDIR') {
    fail(`Input is a directory, not a file: ${inputFile}.`);
  }
  throw e;
}
const resolvedInput = path.resolve(inputFile);
const inputBase = path.basename(inputFile);
const sourceBytes = Buffer.byteLength(source, 'utf8');
const sourceHash = crypto.createHash('sha256').update(source, 'utf8').digest('hex');

// ---------- Language dispatch ----------
function detectLang() {
  if (opts.lang) return opts.lang;
  const ext = path.extname(inputFile).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  if (ext === '.ts' || ext === '.mts' || ext === '.cts' || ext === '.tsx') return 'ts';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.py') return 'py';
  fail(`SplitCode doesn't support ${JSON.stringify(ext || '(no extension)')} files yet — ` +
    `today it splits .js, .ts, .html and .py. ` +
    `Want your type supported? It takes 30 seconds: open a request at ` +
    `https://github.com/unn-Known1/splitcode/issues/new ` +
    `(tell us the extension + what the file looks like) and we'll add it. ` +
    `In the meantime, --lang js|ts|html|py forces the closest frontend.`);
}
const lang = detectLang();

const PART_EXT = { js: '.js', ts: '.ts', html: '.js', py: '.py' };
const LOADER_EXT = { js: '.js', ts: '.ts', html: '.js', py: '.py' };
const COMMENT = { js: '//', ts: '//', html: '//', py: '#' };

function defaultLoaderName() {
  if (lang === 'html') return inputBase.replace(/\.(html?|xhtml)$/i, '') + '.js' || 'app.js';
  let base = inputBase;
  // Peel unknown trailing extensions (app.js.original -> app.js), keep the real one.
  while (/\.[^.]+$/.test(base) && !base.endsWith(LOADER_EXT[lang])) {
    base = base.replace(/\.[^.]+$/, '');
  }
  return base.endsWith(LOADER_EXT[lang]) ? base : base + LOADER_EXT[lang];
}

let loaderName = opts.loader === undefined ? defaultLoaderName() : opts.loader;
if (loaderName) {
  if (!loaderName.endsWith(LOADER_EXT[lang])) {
    fail(`Invalid --loader ${JSON.stringify(loaderName)}: for ${lang} input the loader must end in ${LOADER_EXT[lang]}.`);
  }
  if (!/^[^/\\]+$/.test(loaderName)) fail(`Invalid --loader: no path separators allowed.`);
}
const pageName = lang === 'html' ? inputBase : null;

// ---------- Frontend (friendly errors, never raw stacks for known cases) ----------
let records, parserMode, langNotes;
try {
  phase('analyze', () => {
    if (lang === 'js') {
      const r = analyzeJS(source);
      records = r.records; parserMode = r.parserMode; langNotes = {};
    } else if (lang === 'ts') {
      // v6+ is the native port and no longer ships the parser API — catch that
      // BEFORE loading the frontend, or it dies with a cryptic TypeError.
      let tsVersion = null;
      try {
        tsVersion = require('typescript').version || null;
      } catch (e) {
        const err = new Error(
          'TypeScript support needs the `typescript` package (optional dependency). ' +
          'Install it (`npm i typescript@5`) and rerun — your code stays untouched.');
        err.friendly = true;
        throw err;
      }
      const tsMajor = parseInt(String(tsVersion).split('.')[0], 10);
      if (tsMajor >= 6) {
        fail(`Nice — you're on TypeScript v${tsVersion}! One catch: v6+ is the native port and ` +
          `doesn't ship the parser API SplitCode needs yet. Install the classic line alongside ` +
          `(\`npm i typescript@5\`) and rerun — your code stays untouched.`);
      }
      const { analyzeTS } = require('./lib/frontend-ts');
      const r = analyzeTS(source, inputFile);
      records = r.records; parserMode = r.parserMode; langNotes = {};
    } else if (lang === 'html') {
      const { analyzeHTML } = require('./lib/frontend-html');
      const r = analyzeHTML(source, inputFile, opts);
      records = r.records; parserMode = r.parserMode; langNotes = r.notes;
    } else if (lang === 'py') {
      const { analyzePY } = require('./lib/frontend-py');
      const r = analyzePY(source, inputFile);
      records = r.records; parserMode = r.parserMode; langNotes = r.notes;
    }
  });
} catch (e) {
  if (e && e.friendly) fail(e.message);
  // Parse failures: surface the preflight findings (which ARE parse-tolerant)
  // instead of a raw stack — and honor --check exit codes.
  try {
    const { preflight } = require('./lib/preflight');
    const findings = preflight(source, lang, inputFile);
    if (findings.length) {
      console.log(`Preflight (${lang}): ${findings.filter(f => f.level === 'warn').length} warning(s), ${findings.filter(f => f.level === 'note').length} note(s)`);
      for (const f of findings) console.log(`${f.level === 'warn' ? '⚠' : '•'} [${f.code}] ${f.message}`);
    }
    console.error(`Cannot split ${inputFile}: ${String((e && e.message) || e).split('\n')[0]}`);
    process.exit(opts.check ? 2 : 1);
  } catch (e2) {
    if (e2 && e2.friendly) fail(e2.message);
    throw e; // truly unexpected — keep the stack for bug reports
  }
}

if (records.length <= 1) {
  info(`Note: input has ${records.length} top-level statement(s) — statement-level splitting ` +
    `cannot subdivide a single statement (bundles/IIFE-wrapped libs). ` +
    `Emitting ${records.length} part + loader unchanged.`);
}

// ---------- Preflight: warn about risky patterns BEFORE splitting ----------
let findings = [];
phase('preflight', () => {
  try {
    const { preflight } = require('./lib/preflight');
    findings = preflight(source, lang, inputFile);
  } catch (e) {
    if (e && e.friendly) fail(e.message);
    throw e;
  }
});
{
  const warns = findings.filter(f => f.level === 'warn');
  const notes = findings.filter(f => f.level === 'note');
  if (opts.check || findings.length) {
    if (!(opts.quiet && findings.length === 0)) {
      console.log(`Preflight (${lang}): ${warns.length} warning(s), ${notes.length} note(s)` +
        (findings.length ? '' : ' — clean, no known risk patterns.'));
      for (const f of findings) {
        console.log(`${f.level === 'warn' ? '⚠' : '•'} [${f.code}] ${f.message}`);
      }
    }
  }
  if (opts.check) process.exit(warns.length ? 2 : 0); // 2 = risky, 0 = clean
  if (opts.strict && warns.length) {
    console.error(`--strict: refusing to write with ${warns.length} preflight warning(s). ` +
      `Fix the patterns above or rerun without --strict.`);
    process.exit(2);
  }
}

// ---------- Backend ----------
let analysis, clusters, ordered, order, warnedCycle, finalClusters;
phase('backend', () => {
  analysis = analyzeRecords(records, opts);
  clusters = clusterRecords(records, analysis.clusterEdges, opts);
  ordered = orderClusters(clusters, analysis.orderEdges, opts);
  order = ordered.order;
  warnedCycle = ordered.warnedCycle;
  finalClusters = ordered.clusters;
});

// ---------- Plan output (names + contents) before touching the filesystem --
const byIdx = new Map(records.map(s => [s.idx, s]));
// Reserve the loader name so no cluster file can collide with the entry point.
const usedNames = new Set();
if (loaderName) usedNames.add(loaderName);
const fileNames = nameClusters(order.map(ci => finalClusters[ci]), records, analysis.usageCount, usedNames, PART_EXT[lang]);
const joiner = lang === 'py' ? '\n\n\n' : '\n\n';
const plannedParts = order.map((ci, k) => {
  const cl = finalClusters[ci].slice().sort((a, b) => a - b);
  const fileName = fileNames[k];
  const code = cl.map(i => byIdx.get(i).getCode()).join(joiner);
  const decls = cl.flatMap(i => byIdx.get(i).declaredNames);
  const p = COMMENT[lang];
  const header = `${p} Auto-split from ${inputBase}\n` +
    (decls.length ? `${p} Declares: ${decls.join(', ')}\n` : '') + '\n';
  return { file: fileName, content: header + code + '\n', declares: decls, statementCount: cl.length };
});
const manifest = plannedParts.map(p => ({ file: p.file, declares: p.declares, statementCount: p.statementCount }));

function buildLoaderContent() {
  if (!loaderName) return null;
  if (opts.loaderMode === 'inline') {
    // Self-contained loader: all parts concatenated in manifest order.
    // One file, original name — no document.write, no extra requests, and
    // ordering is structural. Module inputs stay module code (load the
    // loader with type="module" — noted in the header).
    const p = COMMENT[lang];
    const header = `${p} Auto-generated bootstrap loader for ${inputBase} (inline mode)\n` +
      `${p} Contains all split files in dependency order. Keep loading THIS file.\n` +
      (parserMode === 'module' ? `${p} NOTE: module code — load with <script type="module">.\n` : '') + '\n';
    return header + plannedParts.map(part => part.content).join(joiner) + '\n';
  }
  if (lang === 'py') {
    const lines = [
      `# Auto-generated bootstrap loader for ${inputBase}`,
      `# Runs the split files in dependency order in shared globals.`,
      `# Run THIS file (python ${loaderName}) exactly as you ran the original.`,
      `import os`,
      `_HERE = os.path.dirname(os.path.abspath(__file__))`,
      `_FILES = ${JSON.stringify(manifest.map(m => m.file))}`,
      `for _f in _FILES:`,
      `    with open(os.path.join(_HERE, _f), encoding='utf-8') as _fh:`,
      `        exec(compile(_fh.read(), _f, 'exec'), globals())`,
      ``,
    ];
    return lines.join('\n');
  }
  // Synchronous via document.write DURING PARSING: the only single-file
  // mechanism with the same semantics as separate <script> tags.
  // Module inputs get type="module" tags (classic tags can't run them).
  const isModule = parserMode === 'module';
  const typeAttr = isModule ? ' type="module"' : '';
  const loaderCode = `// Auto-generated bootstrap loader for ${inputBase}\n` +
    `// Loads the split files in dependency order. Keep loading THIS file from your pages.\n` +
    (isModule ? `// NOTE: module code — the loader below injects <script type="module"> tags.\n` : '') +
    `(function () {\n` +
    `  var files = ${JSON.stringify(manifest.map(m => m.file))};\n` +
    `  var me = (document.currentScript && document.currentScript.src) || (function () {\n` +
    `    var s = document.getElementsByTagName('script');\n` +
    `    return s[s.length - 1].src;\n` +
    `  })();\n` +
    `  var base = me.slice(0, me.lastIndexOf('/') + 1);\n` +
    `  for (var i = 0; i < files.length; i++) {\n` +
    `    document.write('<script${typeAttr} src="' + base + files[i] + '"><\\/script>');\n` +
    `  }\n` +
    `})();\n`;
  return loaderCode;
}
const loaderContent = buildLoaderContent();

const manifestObj = {
  tool: 'splitcode',
  toolVersion: toolVersion(),
  schemaVersion: 1,
  order: manifest,
  language: lang,
  loader: loaderName, // single entry point; consumers keep loading this file
  loaderMode: opts.loaderMode,
  strict: !!opts.strict,
  hubNamesSuppressed: [...analysis.hubNames],
  hubThreshold: analysis.hubThreshold,
  cycleFallback: warnedCycle,
  sccMerged: ordered.sccMerged,
  parserMode,
  duplicateDeclarations: analysis.duplicateDeclarations,
  input: { file: inputBase, bytes: sourceBytes, statements: records.length, sha256: sourceHash },
  output: {
    statements: manifest.reduce((n, m) => n + m.statementCount, 0),
    bytes: plannedParts.reduce((n, part) => n + Buffer.byteLength(part.content, 'utf8'), 0),
  },
  notes: langNotes || {},
  // `node --check` on reassembled output proves SYNTAX validity only, not
  // that load order is behaviorally correct. Static analysis can miss
  // dynamic edges; smoke-test the split result.
  verified: 'syntax-only',
};
const manifestContent = JSON.stringify(manifestObj, null, 2) + '\n';

let scriptTagsContent = null;
if (lang !== 'py') {
  const base = path.basename(outDir);
  const isModule = parserMode === 'module';
  const typeAttr = isModule ? ' type="module"' : '';
  scriptTagsContent = manifest
    .map(m => `<script${typeAttr} src="${path.posix.join(base, m.file)}"></script>`).join('\n') + '\n';
}

// Planned writes: path (relative to outDir) -> content. Decided BEFORE any
// filesystem mutation so --dry-run and collision checks see the full set.
const plannedWrites = new Map(); // relPath -> content
for (const part of plannedParts) plannedWrites.set(part.file, part.content);
if (loaderName && loaderContent !== null) plannedWrites.set(loaderName, loaderContent);
plannedWrites.set('manifest.json', manifestContent);
if (scriptTagsContent !== null) plannedWrites.set('script-tags.html', scriptTagsContent);
// NOTE: the rewritten HTML page is produced by the frontend during the write
// phase (it needs outDir); its name is reserved here for collision checks.
const plannedNames = new Set(plannedWrites.keys());
if (pageName) plannedNames.add(pageName);

// ---------- Safety: never destroy the input or foreign files (S0) ----------
if (plannedNames.has(inputBase) && path.dirname(resolvedInput) === outDir && !opts.force) {
  fail(`Refusing: outDir ${outDir} is the input's own directory and the output ` +
    `would overwrite ${inputBase} (loader "${loaderName}"${pageName ? `, page "${pageName}"` : ''}). ` +
    `Your source would be destroyed. Use a separate outDir, --loader <other-name>, or --force.`);
}
{
  // Full output-path collision (covers custom --loader matching the input).
  const collisions = [...plannedNames]
    .map(n => path.join(outDir, n))
    .filter(abs => abs === resolvedInput);
  if (collisions.length && !opts.force) {
    fail(`Refusing: output would overwrite the input file itself (${collisions[0]}). ` +
      `Use a separate outDir, rename via --loader, or pass --force (not recommended).`);
  }
}

if (opts.dryRun) {
  console.log(`Dry run — would write ${manifest.length} part(s)${loaderName ? ' + loader ' + loaderName : ''}${pageName ? ' + rewritten page ' + pageName : ''} (+ manifest.json${scriptTagsContent !== null ? ', script-tags.html' : ''}) to ${outDir}:`);
  for (const [name, content] of plannedWrites) {
    console.log(`  ${name} (${Buffer.byteLength(content, 'utf8')} bytes)`);
  }
  if (pageName) console.log(`  ${pageName} (rewritten page, loader tag at first inline block)`);
  if (analysis.hubNames.size) console.log('Suppressed hub globals:', [...analysis.hubNames].join(', '));
  process.exit(0);
}

// ---------- Write output ----------
// Cleanup removes ONLY files this tool owns: exact names it is about to
// write, plus files listed in a previous manifest.json in outDir — never
// extension globs (S0-2: those deleted unrelated user files).
phase('write', () => {
  fs.mkdirSync(outDir, { recursive: true });
  const priorManifest = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    } catch (e) {
      return null;
    }
  })();
  const owned = new Set([...plannedNames, 'manifest.json', 'script-tags.html']);
  if (priorManifest && Array.isArray(priorManifest.order)) {
    for (const m of priorManifest.order) if (m && m.file) owned.add(m.file);
    if (priorManifest.loader) owned.add(priorManifest.loader);
  }
  // Content-hash skip FIRST (before any unlink): byte-identical files are
  // kept as-is, so reruns are cheap and never churn mtimes.
  const keep = new Set();
  for (const [name, content] of plannedWrites) {
    const abs = path.join(outDir, name);
    try {
      if (fs.readFileSync(abs, 'utf8') === content) keep.add(name);
    } catch (e) { /* absent — will write */ }
  }
  // Never delete the input itself (belt and suspenders — the loop also skips it).
  let cleaned = 0;
  const existing = new Set(fs.readdirSync(outDir));
  for (const f of owned) {
    if (!existing.has(f) || keep.has(f)) continue;
    const abs = path.join(outDir, f);
    if (abs === resolvedInput) continue; // input is sacred
    // A pre-existing file we did NOT emit (not in a prior manifest) that we
    // are about to overwrite with DIFFERENT bytes is someone else's file —
    // refuse, don't clobber. (Identical bytes are already in `keep` above.)
    const emittedBefore = !!(priorManifest && (
      (Array.isArray(priorManifest.order) && priorManifest.order.some(m => m && m.file === f)) ||
      priorManifest.loader === f || f === 'manifest.json' || f === 'script-tags.html'));
    if (plannedWrites.has(f) && !emittedBefore && !opts.force) {
      // Fresh-directory (or foreign-file) collision with the same name.
      fail(`Refusing: ${abs} already exists and was not emitted by a previous split. ` +
        `Overwriting it would destroy someone else's content. Rename via --loader, pick another outDir, or pass --force.`);
    }
    fs.unlinkSync(abs);
    cleaned++;
  }
  if (cleaned) info(`Cleaned ${cleaned} stale file(s) from a previous run in ${outDir}.`);

  for (const [name, content] of plannedWrites) {
    if (keep.has(name)) continue;
    fs.writeFileSync(path.join(outDir, name), content);
  }

  if (lang === 'py') {
    // Python loader already included in plannedWrites (uniform path).
  } else if (lang === 'html') {
    const { rewriteHTML } = require('./lib/frontend-html');
    rewriteHTML(source, inputFile, outDir, manifest, loaderName);
  }
  // (JS/TS loaders are plain planned writes above.)

  if (keep.size && !opts.quiet) console.log(`${keep.size} file(s) unchanged — skipped.`);
});

if (analysis.hubNames.size) info('Suppressed hub globals (kept, not used for clustering):', [...analysis.hubNames].join(', '));
console.log(`Wrote ${manifest.length} files${loaderName ? ` + loader ${loaderName}` : ''}${pageName ? ' + rewritten page' : ''} to ${outDir}`);
info('See manifest.json' + (lang === 'py' ? '' : ' and script-tags.html') + ' for load order.');

if (opts.timing) {
  tPhase.total = Date.now() - t0total;
  console.log('Timing (ms): ' + Object.entries(tPhase).map(([k, v]) => `${k}=${v}`).join(' '));
}
