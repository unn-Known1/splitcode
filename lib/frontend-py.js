// lib/frontend-py.js — Python frontend (stdlib ast via python3 subprocess).
const { execFileSync } = require('child_process');
const path = require('path');

const PYFACTS = path.join(__dirname, 'pyfacts.py');
let pythonOk = null;

// Same-run cache: preflightPY reuses analyzePY's facts (records + warns) so
// Python inputs cost ONE python3 spawn per run, not two (P0-2). Keyed by the
// resolved file path AND source identity — split-js.js passes the same
// `source` const to both stages.
let lastPYFacts = null;
function getCachedPYFacts(fileName, source) {
  const abs = path.resolve(fileName);
  if (lastPYFacts && lastPYFacts.abs === abs && lastPYFacts.source === source) return lastPYFacts.facts;
  return null;
}

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
  lastPYFacts = { abs, source, facts };

  // Line starts via indexOf loop (3-5x faster than a char-by-char scan).
  const lineStarts = [0];
  let nl = -1;
  while ((nl = source.indexOf('\n', nl + 1)) !== -1) lineStarts.push(nl + 1);

  // Precompute per-line byte→UTF-16 maps ONCE (CPython columns are UTF-8
  // byte offsets; the old code re-walked each line with Buffer.byteLength
  // per character for EVERY record).
  const lineByteMaps = new Map(); // lineStart -> { bytes: Buffer, units: number[] }
  const unitsForLine = (ls) => {
    let m = lineByteMaps.get(ls);
    if (!m) {
      const lineEnd = source.indexOf('\n', ls);
      const line = source.slice(ls, lineEnd < 0 ? source.length : lineEnd);
      const bytes = Buffer.from(line, 'utf8');
      const units = new Array(bytes.length + 1);
      let u = 0, bi = 0;
      units[0] = 0;
      for (const ch of line) { // code points: astral chars advance 2 units
        const bl = Buffer.byteLength(ch, 'utf8');
        for (let k = 1; k <= bl; k++) units[bi + k] = u + ch.length;
        bi += bl;
        u += ch.length;
      }
      m = { bytes, units };
      lineByteMaps.set(ls, m);
    }
    return m;
  };
  const off = ([ln, col]) => {
    const ls = lineStarts[ln - 1] !== undefined ? lineStarts[ln - 1] : source.length;
    if (ls >= source.length) return source.length;
    const { bytes, units } = unitsForLine(ls);
    const c = Math.min(col, bytes.length);
    return ls + (units[c] !== undefined ? units[c] : units[bytes.length]);
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

module.exports = { analyzePY, getCachedPYFacts };
