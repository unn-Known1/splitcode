// lib/frontend-py.js — Python frontend (stdlib ast via python3 subprocess).
const { execFileSync } = require('child_process');
const path = require('path');

const PYFACTS = path.join(__dirname, 'pyfacts.py');
let pythonOk = null;

function checkPython() {
  if (pythonOk !== null) return pythonOk;
  try {
    execFileSync('python3', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    pythonOk = true;
  } catch (e) {
    pythonOk = false;
  }
  return pythonOk;
}

function analyzePY(source, fileName) {
  if (!checkPython()) {
    throw new Error('Python support requires python3 on PATH (stdlib ast is used for parsing).');
  }
  const abs = path.resolve(fileName);
  let out;
  try {
    out = execFileSync('python3', [PYFACTS, abs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const detail = (e.stderr || e.message || '').toString().split('\n')[0];
    throw new Error(`Python parse failed for ${fileName}: ${detail}`);
  }
  const facts = JSON.parse(out);

  // Line/col -> absolute offsets.
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const off = ([ln, col]) => {
    const ls = lineStarts[ln - 1] !== undefined ? lineStarts[ln - 1] : source.length;
    // col is a UTF-8 BYTE offset in CPython; this string is UTF-16 units.
    // Walk code points until the byte budget is spent (exact for all text).
    const lineEnd = source.indexOf('\n', ls);
    const line = source.slice(ls, lineEnd < 0 ? source.length : lineEnd);
    let u = 0, b = 0;
    for (const ch of line) { // code points: astral chars advance 2 units
      if (b >= col) break;
      b += Buffer.byteLength(ch, 'utf8');
      u += ch.length;
    }
    return ls + u;
  };

  const records = facts.records.map((r, idx) => {
    const start = off(r.start), end = off(r.end);
    return {
      idx,
      start, end,
      isHoisted: !!r.isHoisted,
      declaredNames: [...new Set(r.declared)],
      freeNames: new Set(r.free),
      immediateNames: new Set(r.immediate),
      getCode: () => source.slice(start, end),
    };
  });
  return { records, parserMode: facts.mode || 'script', notes: {} };
}

module.exports = { analyzePY };
