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
 * Usage:
 *   node split-js.js <input.(js|ts|html|py)> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader <name> | --no-loader] [--lang js|ts|html|py] [--check]
 */

const fs = require('fs');
const path = require('path');
const { analyzeRecords, clusterRecords, orderClusters, nameClusters } = require('./lib/backend');
const { analyzeJS } = require('./lib/frontend-js');

// ---------- CLI ----------
const [, , inputFile, outDirArg, ...rest] = process.argv;
if (!inputFile || !outDirArg) {
  console.error('Usage: node split-js.js <input.(js|ts|html|py)> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader <name> | --no-loader] [--lang js|ts|html|py] [--check]');
  process.exit(1);
}
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Friendly runtime gates (checked before any work, so failures read as
// guidance, not stack traces).
{
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 16) {
    fail(`SplitCode runs best on Node.js 16+ — you're on v${process.versions.node}. ` +
      `Good news: upgrading is quick (https://nodejs.org), and everything else is ready to go.`);
  }
}
const opts = { hubRatio: 0.12, minChars: 400, loader: undefined, lang: undefined, check: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--hub-ratio') {
    const raw = rest[++i];
    if (raw === undefined) fail('Missing value for --hub-ratio (expected a number 0..1).');
    opts.hubRatio = parseFloat(raw);
    if (!Number.isFinite(opts.hubRatio) || opts.hubRatio < 0 || opts.hubRatio > 1) {
      fail(`Invalid --hub-ratio ${JSON.stringify(raw)}: expected a number between 0 and 1.`);
    }
  } else if (rest[i] === '--min-chars') {
    const raw = rest[++i];
    if (raw === undefined) fail('Missing value for --min-chars (expected a non-negative integer).');
    opts.minChars = parseInt(raw, 10);
    if (!Number.isFinite(opts.minChars) || opts.minChars < 0) {
      fail(`Invalid --min-chars ${JSON.stringify(raw)}: expected a non-negative integer.`);
    }
  } else if (rest[i] === '--no-loader') {
    opts.loader = null;
  } else if (rest[i] === '--check') {
    opts.check = true;
  } else if (rest[i] === '--loader') {
    const raw = rest[++i];
    if (raw === undefined) fail('Missing value for --loader (expected a file name).');
    if (!/^[^/\\]+$/.test(raw)) {
      fail(`Invalid --loader ${JSON.stringify(raw)}: expected a plain file name (no path separators).`);
    }
    opts.loader = raw;
  } else if (rest[i] === '--lang') {
    const raw = rest[++i];
    if (!['js', 'ts', 'html', 'py'].includes(raw)) {
      fail(`Invalid --lang ${JSON.stringify(raw)}: expected one of js, ts, html, py.`);
    }
    opts.lang = raw;
  } else {
    fail(`Unknown option ${JSON.stringify(rest[i])}. Usage: node split-js.js <input.(js|ts|html|py)> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader <name> | --no-loader] [--lang js|ts|html|py] [--check]`);
  }
}
const outDir = path.resolve(outDirArg);

const source = fs.readFileSync(inputFile, 'utf8');
const inputBase = path.basename(inputFile);

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
  // Peel unknown trailing extensions (app.js.orig -> app.js), keep the real one.
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

// ---------- Frontend ----------
let records, parserMode, langNotes;
if (lang === 'js') {
  const r = analyzeJS(source);
  records = r.records; parserMode = r.parserMode; langNotes = {};
} else if (lang === 'ts') {
  // v6+ is the native port and no longer ships the parser API — catch that
  // BEFORE loading the frontend, or it dies with a cryptic TypeError.
  const tsVersion = require('typescript').version || '0.0.0';
  const tsMajor = parseInt(tsVersion.split('.')[0], 10);
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
  const r = analyzeHTML(source, inputFile);
  records = r.records; parserMode = r.parserMode; langNotes = r.notes;
} else if (lang === 'py') {
  const { analyzePY } = require('./lib/frontend-py');
  let r;
  try {
    r = analyzePY(source, inputFile);
  } catch (e) {
    if (e && e.friendly) fail(e.message);
    throw e;
  }
  records = r.records; parserMode = r.parserMode; langNotes = r.notes;
}

// ---------- Preflight: warn about risky patterns BEFORE splitting ----------
{
  const { preflight } = require('./lib/preflight');
  const findings = preflight(source, lang, inputFile);
  const warns = findings.filter(f => f.level === 'warn');
  const notes = findings.filter(f => f.level === 'note');
  if (opts.check || findings.length) {
    console.log(`Preflight (${lang}): ${warns.length} warning(s), ${notes.length} note(s)` +
      (findings.length ? '' : ' — clean, no known risk patterns.'));
    for (const f of findings) {
      console.log(`${f.level === 'warn' ? '⚠' : '•'} [${f.code}] ${f.message}`);
    }
  }
  if (opts.check) process.exit(warns.length ? 2 : 0); // 2 = risky, 0 = clean
}

// ---------- Backend ----------
const analysis = analyzeRecords(records, opts);
const clusters = clusterRecords(records, analysis.clusterEdges, opts);
const ordered = orderClusters(clusters, analysis.orderEdges);
const order = ordered.order;
const warnedCycle = ordered.warnedCycle;
const finalClusters = ordered.clusters;

// ---------- Write output ----------
// Clear stale tool output first (only files this tool owns).
fs.mkdirSync(outDir, { recursive: true });
{
  const owned = new Set(['manifest.json', 'script-tags.html']);
  const exts = ['.js', '.ts', '.py'];
  if (lang === 'html' && langNotes && langNotes.pageName) owned.add(langNotes.pageName);
  let cleaned = 0;
  for (const f of fs.readdirSync(outDir)) {
    if (owned.has(f) || exts.includes(path.extname(f).toLowerCase())) {
      fs.unlinkSync(path.join(outDir, f));
      cleaned++;
    }
  }
  if (cleaned) console.log(`Cleaned ${cleaned} stale file(s) from a previous run in ${outDir}.`);
}
// Reserve the loader name so no cluster file can collide with the entry point.
const usedNames = new Set();
if (loaderName) usedNames.add(loaderName);
const manifest = [];
{
  const byIdx = new Map(records.map(s => [s.idx, s]));
  const fileNames = nameClusters(order.map(ci => finalClusters[ci]), records, analysis.usageCount, usedNames, PART_EXT[lang]);
  order.forEach((ci, k) => {
    const cl = finalClusters[ci].slice().sort((a, b) => a - b);
    const fileName = fileNames[k];
    const code = cl.map(i => byIdx.get(i).getCode()).join(lang === 'py' ? '\n\n\n' : '\n\n');
    const decls = cl.flatMap(i => byIdx.get(i).declaredNames);
    const p = COMMENT[lang];
    const header = `${p} Auto-split from ${inputBase}\n` +
      (decls.length ? `${p} Declares: ${decls.join(', ')}\n` : '') + '\n';
    fs.writeFileSync(path.join(outDir, fileName), header + code + '\n');
    manifest.push({ file: fileName, declares: decls, statementCount: cl.length });
  });
}

if (lang === 'py') writePythonLoader(manifest);
else {
  writeJSLoader(manifest); // parts loader (also used by the rewritten HTML page)
  if (lang === 'html') writeHTMLPage(manifest);
}

fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify({
    order: manifest,
    language: lang,
    loader: loaderName, // single entry point; consumers keep loading this file
    hubNamesSuppressed: [...analysis.hubNames],
    cycleFallback: warnedCycle,
    sccMerged: ordered.sccMerged,
    parserMode,
    duplicateDeclarations: analysis.duplicateDeclarations,
    notes: langNotes || {},
    // `node --check` on reassembled output proves SYNTAX validity only, not
    // that load order is behaviorally correct. Static analysis can miss
    // dynamic edges; smoke-test the split result.
    verified: 'syntax-only',
  }, null, 2)
);

if (lang !== 'py') {
  const base = lang === 'html' && langNotes.pageName
    ? path.basename(outDir)
    : path.basename(outDir);
  const scriptTags = manifest.map(m => `<script src="${path.posix.join(base, m.file)}"></script>`).join('\n');
  fs.writeFileSync(path.join(outDir, 'script-tags.html'), scriptTags + '\n');
}

console.log(`Wrote ${manifest.length} files${loaderName ? ` + loader ${loaderName}` : ''} to ${outDir}`);
if (analysis.hubNames.size) console.log('Suppressed hub globals (kept, not used for clustering):', [...analysis.hubNames].join(', '));
console.log('See manifest.json' + (lang === 'py' ? '' : ' and script-tags.html') + ' for load order.');

// ---------- Loaders ----------
function writeJSLoader(manifest) {
  // Synchronous via document.write DURING PARSING: the only single-file
  // mechanism with the same semantics as separate <script> tags.
  if (!loaderName) return;
  const loaderCode = `// Auto-generated bootstrap loader for ${inputBase}\n` +
    `// Loads the split files in dependency order. Keep loading THIS file from your pages.\n` +
    `(function () {\n` +
    `  var files = ${JSON.stringify(manifest.map(m => m.file))};\n` +
    `  var me = (document.currentScript && document.currentScript.src) || (function () {\n` +
    `    var s = document.getElementsByTagName('script');\n` +
    `    return s[s.length - 1].src;\n` +
    `  })();\n` +
    `  var base = me.slice(0, me.lastIndexOf('/') + 1);\n` +
    `  for (var i = 0; i < files.length; i++) {\n` +
    `    document.write('<script src="' + base + files[i] + '"><\\/script>');\n` +
    `  }\n` +
    `})();\n`;
  fs.writeFileSync(path.join(outDir, loaderName), loaderCode);
}

function writePythonLoader(manifest) {
  // Parts share ONE globals dict with the bootstrap, so module-level names
  // behave exactly as in the original single file. `if __name__ ==
  // "__main__"` blocks see the bootstrap's __name__ — identical blocks run
  // exactly as before. Caveat: `__file__` inside a part points at the
  // bootstrap, not the original file.
  if (!loaderName) return;
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
  fs.writeFileSync(path.join(outDir, loaderName), lines.join('\n'));
}

function writeHTMLPage(manifest) {
  const { rewriteHTML } = require('./lib/frontend-html');
  rewriteHTML(source, inputFile, outDir, manifest, loaderName);
}
