// test/bench.js — SplitCode micro-benchmarks (no assertions, exit 0 unless crash).
// Usage: npm run bench
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'split-js.js');
const row = (name, ms) => console.log(`${String(name).padEnd(44)} ${ms} ms`);

let t0 = Date.now();
require(path.join(ROOT, 'lib', 'preflight'));
row('require lib/preflight (startup floor)', Date.now() - t0);

function cli(input, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitcode-bench-'));
  const t = Date.now();
  const r = spawnSync(process.execPath, [CLI, input, dir, ...(extra || [])], { encoding: 'utf8' });
  const ms = Date.now() - t;
  if (r.status !== 0) console.log(`  !! exit ${r.status}: ${(r.stderr || '').split('\n')[0]}`);
  return ms;
}

row('TEST/adversarial.js full run', cli(path.join(ROOT, 'TEST', 'adversarial.js')));
row('TEST/jquery-3.7.1.js full run', cli(path.join(ROOT, 'TEST', 'jquery-3.7.1.js')));
row('TEST/jquery-3.7.1.min.js full run', cli(path.join(ROOT, 'TEST', 'jquery-3.7.1.min.js')));

// Synthetic chain: one connected component (Louvain path).
let chain = 'var v0 = 0;\n';
for (let i = 1; i < 4000; i++) chain += `var v${i} = v${i - 1} + 1;\n`;
const chainFile = path.join(os.tmpdir(), 'splitcode-bench-chain.js');
fs.writeFileSync(chainFile, chain);
row('synthetic chain 4000 stmts', cli(chainFile));

// Synthetic independent: many clusters (Kahn path).
let indep = '';
for (let i = 0; i < 3000; i++) indep += `var u${i}_${i} = ${i};\n`;
const indepFile = path.join(os.tmpdir(), 'splitcode-bench-indep.js');
fs.writeFileSync(indepFile, indep);
row('synthetic indep 3000 stmts --min-chars 1', cli(indepFile, ['--min-chars', '1']));
