// test/run.js — SplitCode test suite (no dependencies, Node >= 16).
//
// Covers the drop-in contract acceptance bar (AGENTS.md items 8-9):
// behavioral equivalence under REAL per-file loading semantics, safety
// refusals, preflight codes, manifest auditability, and conservation.
//
// Usage: npm test  (exit 0 = all pass, 1 = failures)
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'split-js.js');
const FX = path.join(ROOT, 'test', 'fixtures');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`FAIL - ${name}: ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `splitcode-test-${prefix}-`));
}
function runCli(args, opts) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', ...(opts || {}),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}
// Execute split parts the way a browser would: SEPARATE scripts, one shared
// global scope, manifest.json order. (Concatenating first would let hoisting
// cross file boundaries and mask real breaks — see report §9.)
function execSplitPerFile(dir, manifest) {
  const logs = [];
  const sandbox = { console: { log: (...a) => logs.push(a.join(' ')) } };
  vm.createContext(sandbox);
  for (const o of manifest.order) {
    const code = fs.readFileSync(path.join(dir, o.file), 'utf8');
    vm.runInContext(code, sandbox, { filename: o.file });
  }
  return logs;
}
function execFileNode(file) {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  assert(r.status === 0, `node ${file} exited ${r.status}: ${r.stderr}`);
  return (r.stdout || '').trim().split('\n');
}
function hasPython3() {
  const r = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

// ---------- CLI basics ----------
test('--help exits 0 with usage', () => {
  const r = runCli(['--help']);
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.stdout.includes('Usage'), 'no Usage in --help');
  assert(r.stdout.includes('Exit codes'), 'no exit-code docs');
});
test('--version exits 0', () => {
  const r = runCli(['--version']);
  assert(r.status === 0, `exit ${r.status}`);
  assert(r.stdout.includes('splitcode'), 'no version string');
});
test('--check works without outDir and writes nothing', () => {
  const before = new Set(fs.readdirSync(ROOT));
  const r = runCli([path.join(FX, 'features.js'), '--check']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const after = new Set(fs.readdirSync(ROOT));
  assert(!after.has('--check'), 'stray ./--check directory created (S0-3)');
  assert(before.size === after.size, 'unexpected files created in repo root');
});
test('broken input --check exits 2 with parse-error (no stack)', () => {
  const r = runCli([path.join(FX, 'broken.js'), mkTmp('x'), '--check']);
  assert(r.status === 2, `exit ${r.status}`);
  assert(r.stdout.includes('[parse-error]'), 'missing parse-error finding');
  assert(!r.stdout.includes('    at '), 'raw stack leaked');
});
test('broken input normal run exits 1 friendly', () => {
  const r = runCli([path.join(FX, 'broken.js'), mkTmp('x')]);
  assert(r.status === 1, `exit ${r.status}`);
  assert(/Cannot split/.test(r.stdout + r.stderr), 'missing friendly message');
});
test('missing input exits 1 friendly', () => {
  const r = runCli([path.join(mkTmp('x'), 'nope.js'), mkTmp('y')]);
  assert(r.status === 1, `exit ${r.status}`);
  assert(/not found/i.test(r.stdout + r.stderr), 'missing friendly ENOENT');
});
test('float --min-chars rejected', () => {
  const r = runCli([path.join(FX, 'features.js'), mkTmp('x'), '--min-chars', '3.7']);
  assert(r.status === 1, `exit ${r.status}`);
});
test('--max-bytes refusal is friendly', () => {
  const r = runCli([path.join(FX, 'features.js'), mkTmp('x'), '--max-bytes', '10']);
  assert(r.status === 1, `exit ${r.status}`);
  assert(/--max-bytes/.test(r.stdout + r.stderr), 'no max-bytes hint');
});

// ---------- preflight codes + strict ----------
const SNEAKY_CODES = ['indirect-eval', 'string-callback', 'cjs-require',
  'dynamic-global-key', 'prototype-methods', 'implicit-global', 'import-scripts'];
test('sneaky fixture fires all new warn/note codes', () => {
  const r = runCli([path.join(FX, 'sneaky.js'), mkTmp('x'), '--check']);
  assert(r.status === 2, `exit ${r.status}`);
  for (const code of SNEAKY_CODES) {
    assert(r.stdout.includes(`[${code}]`), `missing code ${code}:\n${r.stdout}`);
  }
});
test('--strict refuses warned input and writes nothing', () => {
  const dir = path.join(mkTmp('x'), 'out');
  const r = runCli([path.join(FX, 'sneaky.js'), dir, '--strict']);
  assert(r.status === 2, `exit ${r.status}`);
  assert(!fs.existsSync(dir), 'strict run wrote output anyway');
});
test('--strict passes clean input', () => {
  const dir = mkTmp('strict-clean');
  const r = runCli([path.join(FX, 'features.js'), dir, '--strict']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(fs.existsSync(path.join(dir, 'manifest.json')), 'no manifest');
});

// ---------- drop-in acceptance bar ----------
test('dup last-wins probe passes under per-file execution', () => {
  const dir = mkTmp('dup');
  const r = runCli([path.join(FX, 'dup.js'), dir, '--min-chars', '1']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const m = readManifest(dir);
  const logs = execSplitPerFile(dir, m);
  assert(logs.length === 1 && logs[0] === '2', `expected ["2"], got ${JSON.stringify(logs)}`);
});
test('multi-file feature split matches original stdout', () => {
  const dir = mkTmp('feat');
  const r = runCli([path.join(FX, 'features.js'), dir, '--min-chars', '1']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const m = readManifest(dir);
  assert(m.order.length >= 2, `expected >=2 files, got ${m.order.length}`);
  const expected = execFileNode(path.join(FX, 'features.js'));
  const actual = execSplitPerFile(dir, m);
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `mismatch: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
});
test('inline loader executes to identical stdout', () => {
  const dir = mkTmp('inline');
  const r = runCli([path.join(FX, 'features.js'), dir, '--loader-mode', 'inline']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const m = readManifest(dir);
  assert(m.loaderMode === 'inline', 'manifest loaderMode not recorded');
  const loader = m.loader;
  assert(loader, 'no loader recorded');
  const expected = execFileNode(path.join(FX, 'features.js'));
  const actual = execFileNode(path.join(dir, loader));
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'inline output differs');
});
test('ESM input gets a type=module loader', () => {
  const dir = mkTmp('esm');
  const r = runCli([path.join(FX, 'esm.js'), dir]);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const m = readManifest(dir);
  assert(m.parserMode === 'module', 'parserMode not module');
  const loaderSrc = fs.readFileSync(path.join(dir, m.loader), 'utf8');
  assert(loaderSrc.includes('type="module"'), 'loader lacks type=module');
  const tags = fs.readFileSync(path.join(dir, 'script-tags.html'), 'utf8');
  assert(tags.includes('type="module"'), 'script-tags lack type=module');
});

// ---------- conservation + ordering ----------
test('adversarial: statement conservation + order validity + syntax', () => {
  const dir = mkTmp('adv');
  const r = runCli([path.join(ROOT, 'TEST', 'adversarial.js'), dir]);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const m = readManifest(dir);
  assert(m.input.statements > 0, 'no input count recorded');
  assert(m.output.statements === m.input.statements,
    `conservation: ${m.output.statements} != ${m.input.statements}`);
  assert(m.tool === 'splitcode' && m.schemaVersion === 1 && m.input.sha256, 'manifest audit fields missing');
  // Every order edge must point backward-or-equal in file order.
  const { analyzeJS } = require(path.join(ROOT, 'lib', 'frontend-js'));
  const { analyzeRecords } = require(path.join(ROOT, 'lib', 'backend'));
  const src = fs.readFileSync(path.join(ROOT, 'TEST', 'adversarial.js'), 'utf8');
  const { records } = analyzeJS(src);
  const a = analyzeRecords(records, { hubRatio: 0.12, minChars: 400 });
  // Precise map: statement idx -> file position. A statement lives in the
  // earliest file declaring any of its names; statements declaring nothing
  // are ordering-neutral for this check.
  const stmtFile = new Map();
  // Rebuild clusters from manifest declares: map each declared name to first file listing it.
  const declFile = new Map();
  m.order.forEach((o, i) => o.declares.forEach((d) => { if (!declFile.has(d)) declFile.set(d, i); }));
  for (const s of records) {
    // A statement lives in the earliest file declaring any of its names;
    // statements declaring nothing are ordering-neutral for this check.
    let pos = Infinity;
    for (const n of s.declaredNames) if (declFile.has(n)) pos = Math.min(pos, declFile.get(n));
    if (pos !== Infinity) stmtFile.set(s.idx, pos);
  }
  let violations = 0;
  for (const e of a.orderEdges) {
    const pf = stmtFile.get(e.from), pt = stmtFile.get(e.to);
    if (pf !== undefined && pt !== undefined && pf < pt) violations++;
  }
  assert(violations === 0, `${violations} ordering violations`);
  // Reassembled output passes node --check.
  const concat = m.order.map((o) => fs.readFileSync(path.join(dir, o.file), 'utf8')).join('\n');
  const tmp = path.join(mkTmp('chk'), 'reasm.js');
  fs.writeFileSync(tmp, concat);
  const chk = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  assert(chk.status === 0, `reassembled --check failed: ${chk.stderr}`);
});
test('jquery smoke: splits without crashing', () => {
  const dir = mkTmp('jq');
  const r = runCli([path.join(ROOT, 'TEST', 'jquery-3.7.1.js'), dir]);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const m = readManifest(dir);
  assert(m.output.statements === m.input.statements, 'conservation failed');
});
test('scope semantics: deferred stays deferred, IIFE is immediate', () => {
  const { analyzeJS } = require(path.join(ROOT, 'lib', 'frontend-js'));
  const { analyzeRecords } = require(path.join(ROOT, 'lib', 'backend'));
  const src = 'setTimeout(function () { console.log(a); }, 0);\n' +
    'var a = 1;\n' +
    'var t = (function () { return b; })();\n' +
    'var b = 2;\n';
  const { records } = analyzeJS(src);
  const a = analyzeRecords(records, { hubRatio: 0.12, minChars: 400, quiet: true });
  const edge = (from, to) => a.orderEdges.some((e) => e.from === from && e.to === to);
  assert(!edge(0, 1), 'deferred setTimeout callback forced a load-order edge');
  assert(edge(2, 3), 'IIFE immediate reference produced no order edge');
});

// ---------- safety (S0) ----------
test('input-dir collision refused, input intact', () => {
  const dir = mkTmp('clobber');
  const input = path.join(dir, 'app.js');
  const before = 'var a = 1;\nvar b = a + 1;\nconsole.log(b);\n';
  fs.writeFileSync(input, before);
  const r = runCli([input, dir]);
  assert(r.status !== 0, `exit ${r.status} — should refuse`);
  assert(/Refusing/.test(r.stdout + r.stderr), 'no refusal message');
  assert(fs.readFileSync(input, 'utf8') === before, 'INPUT WAS MODIFIED');
});
test('--force overrides the collision guard', () => {
  const dir = mkTmp('clobberf');
  const input = path.join(dir, 'app.js');
  fs.writeFileSync(input, 'var a = 1;\n');
  const r = runCli([input, dir, '--force']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
});
test('foreign files in outDir are preserved', () => {
  const dir = mkTmp('victim');
  const keep = path.join(dir, 'keep.js');
  fs.writeFileSync(keep, '// precious\nvar keep = 42;\n');
  const input = path.join(mkTmp('in'), 'a.js');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, 'var a = 1;\n');
  const r = runCli([input, dir]);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(fs.existsSync(keep), 'foreign keep.js was deleted (S0-2)');
  assert(fs.readFileSync(keep, 'utf8').includes('precious'), 'keep.js modified');
});
test('rerun reuses manifest-tracked cleanup (no orphans, no foreign deletes)', () => {
  const dir = mkTmp('rerun');
  const input = path.join(FX, 'features.js');
  let r = runCli([input, dir, '--min-chars', '1']);
  assert(r.status === 0, `first exit ${r.status}`);
  const first = new Set(fs.readdirSync(dir));
  fs.writeFileSync(path.join(dir, 'user.js'), 'var user = 1;\n');
  r = runCli([input, dir, '--min-chars', '1']);
  assert(r.status === 0, `second exit ${r.status}: ${r.stderr}`);
  assert(fs.existsSync(path.join(dir, 'user.js')), 'foreign user.js deleted on rerun');
  for (const f of fs.readdirSync(dir)) {
    if (f === 'user.js') continue;
    assert(first.has(f), `orphan file from changed plan not cleaned: ${f}`);
  }
});

// ---------- misc correctness ----------
test('empty-base declaration gets a section-N name (no hidden .js)', () => {
  const dir = mkTmp('eb');
  const r = runCli([path.join(FX, 'emptybase.js'), dir]);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const files = fs.readdirSync(dir);
  assert(!files.includes('.js'), 'hidden .js file emitted');
  assert(files.some((f) => f.startsWith('section-')), `no section-N fallback: ${files}`);
});
test('HTML rewrite preserves non-script bytes', () => {
  const dir = mkTmp('html');
  const r = runCli([path.join(FX, 'page.html'), dir]);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const m = readManifest(dir);
  const page = m.notes && m.notes.pageName;
  assert(page, 'no pageName in manifest notes');
  const rewritten = fs.readFileSync(path.join(dir, page), 'utf8');
  assert(rewritten.includes('<hr/>'), 'serializer normalized <hr/> (S2-4)');
  assert(rewritten.includes('<script src="page.js"></script>'), 'loader tag missing');
  assert(!rewritten.includes('var v1 = 1;'), 'inline block not removed');
});
test('hash-skip makes reruns cheap', () => {
  const dir = mkTmp('skip');
  let r = runCli([path.join(FX, 'features.js'), dir]);
  assert(r.status === 0, `first exit ${r.status}`);
  r = runCli([path.join(FX, 'features.js'), dir]);
  assert(r.status === 0, `second exit ${r.status}`);
  assert(/unchanged — skipped/.test(r.stdout), `no hash-skip message:\n${r.stdout}`);
});
test('--dry-run writes nothing', () => {
  const dir = path.join(mkTmp('dry'), 'out');
  const r = runCli([path.join(FX, 'features.js'), dir, '--dry-run']);
  assert(r.status === 0, `exit ${r.status}`);
  assert(/Dry run/.test(r.stdout), 'no dry-run header');
  assert(!fs.existsSync(dir), 'dry-run created outDir');
});
test('--timing prints phase table', () => {
  const r = runCli([path.join(FX, 'features.js'), mkTmp('t'), '--timing']);
  assert(r.status === 0, `exit ${r.status}`);
  assert(/Timing \(ms\):/.test(r.stdout), 'no timing line');
});
test('--no-louvain and --no-hubs smoke', () => {
  const dir = mkTmp('flags');
  let r = runCli([path.join(ROOT, 'TEST', 'adversarial.js'), dir, '--no-louvain', '--no-hubs']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const m = readManifest(dir);
  assert(m.hubNamesSuppressed.length === 0, 'no-hubs ignored');
});

// ---------- python (needs python3) ----------
if (hasPython3()) {
  test('python: relative import fails closed under --strict', () => {
    const dir = path.join(mkTmp('py'), 'out');
    const r = runCli([path.join(FX, 'relimport.py'), dir, '--strict']);
    assert(r.status === 2, `exit ${r.status}`);
    assert(!fs.existsSync(dir), 'strict run wrote output anyway');
  });
  test('python: clean split works with single spawn path', () => {
    const dir = mkTmp('pyok');
    const input = path.join(dir, 'tiny.py');
    fs.writeFileSync(input, 'x = 1\nprint(x + 1)\n');
    const out = path.join(dir, 'out');
    const r = runCli([input, out]);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert(m.language === 'py' && m.output.statements === m.input.statements, 'py conservation');
  });
} else {
  console.log('skip - python3 not on PATH (2 python tests)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
