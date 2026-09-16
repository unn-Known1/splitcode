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
const { parse } = require('node-html-parser');
const { parseJSBlock, buildRecords } = require('./frontend-js');

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

function analyzeHTML(source, fileName) {
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
    console.log('⚠ External <script src> sits between inline blocks — it cannot be ordered against the pool. Verify manually.');
  }
  if (skippedBlocks.length) {
    console.log('Skipped script blocks (left in place):',
      skippedBlocks.map(b => `#${b.index}: ${b.reason}`).join('; '));
  }

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

// Rewrite: drop processed inline blocks, insert loader tag at the first one.
function rewriteHTML(source, fileName, outDir, manifest, loaderName) {
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
}

module.exports = { analyzeHTML, rewriteHTML };
