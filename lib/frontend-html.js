// lib/frontend-html.js — HTML frontend.
//
// Pools ALL inline classic <script> blocks into one statement list, so
// cross-block dependencies cluster and order correctly. External `src`
// scripts are left untouched. Output = rewritten page (inline blocks replaced
// by one loader tag at the first block's position) + split .js parts.
//
// Honest limits (warned, recorded in manifest notes):
// - <script type="module"> and non-JS types (ld+json, templates) are skipped.
// - A block that fails to parse is left in place and excluded (deps crossing
//   into it are invisible).
// - An external src script sitting BETWEEN two inline blocks can't be
//   ordered against the pool — warned as externalInterleave.
const { parseJSBlock, buildRecords } = require('./frontend-js');

// Lazily loaded so pure-JS runs never pay the import cost (P0-1).
let htmlParse = null;
function needHTMLParser() {
  if (!htmlParse) {
    try {
      htmlParse = require('node-html-parser').parse;
    } catch (e) {
      const err = new Error(
        'HTML support needs the `node-html-parser` package. Run `npm install` and rerun.'
      );
      err.friendly = true;
      throw err;
    }
  }
  return htmlParse;
}

// Same-run cache: preflightHTML and rewriteHTML reuse analyzeHTML's parse
// of this exact string instead of parsing again (P0-2). `decisions` maps
// script index -> 'process' | 'skip', `ranges` maps processed script index ->
// [start, end] source offsets (node-html-parser `range`) for span-splicing.
let lastHTMLParse = null;
function getCachedHTMLParse(source) {
  return (lastHTMLParse && lastHTMLParse.source === source) ? lastHTMLParse : null;
}

const CLASSIC_TYPES = new Set([
  undefined, null, '',
  'text/javascript', 'application/javascript', 'text/ecmascript',
  'application/ecmascript', 'text/jscript',
]);

function scriptKind(node) {
  if (node.getAttribute('src') !== undefined && node.getAttribute('src') !== null) {
    return { inline: false };
  }
  const type = node.getAttribute('type');
  if (type === 'module') return { inline: false, reason: 'module script (left in place)' };
  if (!CLASSIC_TYPES.has(type)) return { inline: false, reason: `type=${type} (left in place)` };
  return { inline: true };
}

function analyzeHTML(source, fileName, opts) {
  const parse = needHTMLParser();
  const quiet = !!(opts && opts.quiet);
  const root = parse(source);
  const scripts = root.querySelectorAll('script');
  const kinds = scripts.map(scriptKind);
  const records = [];
  const skippedBlocks = [];
  const processedNodes = [];

  // Interleave check: an external src script sitting between two processed
  // inline blocks can't be ordered against the pool — warn honestly.
  let firstInline = -1, lastInline = -1;
  kinds.forEach((k, i) => { if (k.inline) { if (firstInline < 0) firstInline = i; lastInline = i; } });
  const externalInterleave = firstInline >= 0 && lastInline > firstInline &&
    kinds.some((k, i) => {
      const isExt = scripts[i].getAttribute('src') !== undefined && scripts[i].getAttribute('src') !== null;
      return isExt && i > firstInline && i < lastInline;
    });

  scripts.forEach((node, i) => {
    const k = kinds[i];
    if (!k.inline) {
      if (k.reason) skippedBlocks.push({ index: i, reason: k.reason });
      return;
    }
    const content = node.innerHTML;
    if (!content.trim()) return; // empty block — leave it
    let parsed;
    try {
      parsed = parseJSBlock(content);
    } catch (e) {
      skippedBlocks.push({ index: i, reason: `parse error, left in place: ${e.message.split('\n')[0]}` });
      return;
    }
    const blockRecords = buildRecords(content, parsed.body, parsed.comments);
    for (const r of blockRecords) {
      r.idx = records.length;
      r.block = i;
      records.push(r);
    }
    processedNodes.push(node);
  });

  if (externalInterleave) {
    if (!quiet) console.log('⚠ External <script src> sits between inline blocks — it cannot be ordered against the pool. Verify manually.');
  }
  if (skippedBlocks.length) {
    if (!quiet) console.log('Skipped script blocks (left in place):',
      skippedBlocks.map(b => `#${b.index}: ${b.reason}`).join('; '));
  }

  const decisions = kinds.map((k, i) => {
    if (!k.inline) return 'skip';
    const node = scripts[i];
    if (!node.innerHTML.trim()) return 'skip-empty';
    try { parseJSBlock(node.innerHTML); } catch (e) { return 'skip-unparseable'; }
    return 'process';
  });
  const ranges = {};
  scripts.forEach((node, i) => {
    if (decisions[i] === 'process' && Array.isArray(node.range)) ranges[i] = node.range.slice(0, 2);
  });
  lastHTMLParse = { source, root, scripts, kinds, decisions, ranges };

  return {
    records,
    parserMode: 'script',
    notes: {
      pageName: fileName.split(/[\\/]/).pop(),
      blockCount: processedNodes.length,
      skippedBlocks,
      externalInterleave: !!externalInterleave,
    },
    _processedNodes: processedNodes,
  };
}

// Rewrite by SOURCE-SPAN SPLICING (P2/S2-4 fix): only the processed inline
// blocks are touched; every other byte of the page is preserved verbatim.
// The old parse+serialize round-trip normalized unrelated markup
// (`<hr/>` → `<hr>`, trailing newline), which could break XHTML-served pages
// and polluted diffs. Falls back to the legacy rewrite only when source
// offsets are unavailable.
function rewriteHTML(source, fileName, outDir, manifest, loaderName) {
  const fs = require('fs');
  const path = require('path');
  const cached = getCachedHTMLParse(source);
  const pageName = fileName.split(/[\\/]/).pop();
  const loaderTag = loaderName ? `<script src="${loaderName}"></script>` : '';

  if (cached && Object.keys(cached.ranges).length) {
    // Splice from END to START so earlier offsets stay valid; the loader tag
    // lands at the FIRST processed block's position, later blocks are removed.
    const order = Object.keys(cached.ranges).map(Number).sort((a, b) => b - a);
    const firstIdx = Math.min(...order);
    let html = source;
    for (const i of order) {
      const [start, end] = cached.ranges[i];
      html = html.slice(0, start) + (i === firstIdx ? loaderTag : '') + html.slice(end);
    }
    if (!html.endsWith('\n')) html += '\n';
    fs.writeFileSync(path.join(outDir, pageName), html);
    return { method: 'splice' };
  }
  return rewriteHTMLLegacy(source, fileName, outDir, manifest, loaderName);
}

// Legacy parse+serialize rewrite (kept as fallback when ranges are missing).
function rewriteHTMLLegacy(source, fileName, outDir, manifest, loaderName) {
  const parse = needHTMLParser();
  const fs = require('fs');
  const path = require('path');
  const root = parse(source);
  const scripts = root.querySelectorAll('script');
  const kinds = scripts.map(scriptKind);
  let first = null;
  scripts.forEach((node, i) => {
    if (!kinds[i].inline) return;
    if (!node.innerHTML.trim()) return;
    try { parseJSBlock(node.innerHTML); } catch (e) { return; } // same skip rule as analyze
    if (!first) first = node;
    else node.remove();
  });
  const pageName = fileName.split(/[\\/]/).pop();
  if (first) {
    if (loaderName) first.replaceWith(`<script src="${loaderName}"></script>`);
    else first.remove();
  }
  fs.writeFileSync(path.join(outDir, pageName), root.toString() + '\n');
  return { method: 'legacy' };
}

module.exports = { analyzeHTML, rewriteHTML, getCachedHTMLParse, needHTMLParser, rewriteHTMLLegacy };
