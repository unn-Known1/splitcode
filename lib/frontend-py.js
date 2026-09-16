// lib/frontend-py.js — Python frontend (stdlib ast via python3 subprocess).
const { execFileSync } = require('child_process');
const path = require('path');

const PYFACTS = path.join(__dirname, 'pyfacts.py');
let pythonOk = null;

function checkPython() {
  // Returns { ok, version } — needs 3.8+ (ast end positions).
  if (pythonOk !== null) return pythonOk;
  try {
    const out = execFileSync('python3', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /Python\s+(\d+)\.(\d+)/.exec(out || '');
    const version = m ? `${m[1]}.${m[2]}` : 'unknown';
    pythonOk = m && (parseInt(m[1], 10) > 3 || (parseInt(m[1], 10) === 3 && parseInt(m[2], 10) >= 8))
      ? { ok: true, version }
      : { ok: false, version };
  } catch (e) {
    pythonOk = { ok: false, version: 'not found' };
  }
  return pythonOk;
}

function analyzePY(source, fileName) {
  const py = checkPython();
  if (!py.ok) {
    const err = new Error(
      `Almost there — Python support needs python3.8+ (for AST positions); ` +
      (py.version === 'not found'
        ? `found no python3 on PATH at all. Install one and rerun — your code stays untouched.`
        : `found ${py.version}. Install a newer python3 on PATH and rerun — your code stays untouched.`)
    );
    err.friendly = true; // entry prints err.message cleanly (no stack) via fail()
    throw err;
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
