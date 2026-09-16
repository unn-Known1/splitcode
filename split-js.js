#!/usr/bin/env node
/**
 * SplitJS (split-js.js) — split a large JavaScript file into multiple
 * dependency-ordered files. Purely mechanical JS "module splitter".
 *
 * Given one big non-module JS file (plain <script>, no import/export),
 * this:
 *   1. Parses it with acorn into an AST.
 *   2. Finds every top-level declaration (function/class/var/let/const,
 *      import bindings, plus global writes like `foo = ...`,
 *      `window.foo = ...`, and `Object.assign(window, {...})`)
 *      and every other top-level statement.
 *   3. Walks each statement's body with a scope-aware free-variable
 *      collector to see which OTHER top-level names it touches, distinguishing
 *      references that run IMMEDIATELY from ones deferred inside a callback.
 *      Immediately-invoked functions (IIFEs), Promise executors, and a small
 *      allowlist of known-synchronous callbacks (arr.map/forEach/...,
 *      str.replace(re, fn), ...) count as immediate. Block scoping
 *      (if/for/switch/bare `{}`) is respected; `var` hoists to the nearest
 *      function scope; `with` bodies are treated conservatively (all refs live).
 *      NOTE: the sync-callback list is heuristic — distinguishing "callback
 *      that runs now" from "callback stored for later" for an ARBITRARY
 *      receiver is undecidable by pure syntax analysis. Unknown receivers
 *      default to deferred, which can MISS a real ordering edge silently
 *      (no warning, possible runtime ReferenceError). When in doubt, keep
 *      synchronously-coupled code in one file and smoke-test the result.
 *   4. Builds a dependency graph from that, clusters connected
 *      declarations together (excluding "hub" globals referenced
 *      almost everywhere, which would otherwise glue the whole file
 *      into one blob), and merges tiny clusters into neighbours.
 *   5. Orders the resulting files so nothing runs before something
 *      it depends on (functions may move freely — they're hoisted —
 *      but any statement that executes immediately, e.g. a bare
 *      `document.addEventListener(...)` call or a `const x = f()`,
 *      keeps its original relative position across files).
 *   6. Writes each cluster to its own file, plus a manifest.json,
 *      ready-to-paste <script> tags in the correct order, and (by default)
 *      a bootstrap loader named app.js: pages keep loading just that ONE
 *      file exactly as before, and it pulls in the split files in order —
 *      no HTML/loader/config changes needed elsewhere.
 *      (--no-loader disables it; --loader <name> renames it.)
 *
 * No LLM involved — this is 100% static analysis over the AST.
 *
 * Usage:
 *   node split-js.js <input.js> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader app.js | --no-loader]
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

// ---------- CLI ----------
const [, , inputFile, outDirArg, ...rest] = process.argv;
if (!inputFile || !outDirArg) {
  console.error('Usage: node split-js.js <input.js> <outDir> [--hub-ratio 0.12] [--min-chars 400]');
  process.exit(1);
}
function fail(msg) {
  console.error(msg);
  process.exit(1);
}
const opts = { hubRatio: 0.12, minChars: 400, loader: 'app.js' };
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
  } else if (rest[i] === '--loader') {
    const raw = rest[++i];
    if (raw === undefined) fail('Missing value for --loader (expected a file name like app.js).');
    if (!/^[^/\\]+\.js$/.test(raw)) {
      fail(`Invalid --loader ${JSON.stringify(raw)}: expected a plain file name ending in .js (no path separators).`);
    }
    opts.loader = raw;
  } else {
    fail(`Unknown option ${JSON.stringify(rest[i])}. Usage: node split-js.js <input.js> <outDir> [--hub-ratio 0.12] [--min-chars 400] [--loader app.js | --no-loader]`);
  }
}
const outDir = path.resolve(outDirArg);
fs.mkdirSync(outDir, { recursive: true });

const source = fs.readFileSync(inputFile, 'utf8');

// ---------- Parse ----------
// Plain <script> first; fall back to ESM so a file with import/export at
// least parses. Imports bind local names (handled in declaredNamesOfStatement
// + the walker); bare `import`/`export` statements otherwise carry no edges.
const comments = [];
const parseOpts = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowReturnOutsideFunction: true,
  onComment: comments,
};
let ast;
let parserMode = 'script';
try {
  ast = acorn.parse(source, parseOpts);
} catch (scriptErr) {
  try {
    ast = acorn.parse(source, { ...parseOpts, sourceType: 'module' });
    parserMode = 'module';
  } catch (moduleErr) {
    throw scriptErr;
  }
}

// Names that unambiguously mean "the global object" in a classic script.
const GLOBAL_OBJS = new Set(['window', 'globalThis', 'self', 'global']);

// Higher-order functions whose callback argument is invoked synchronously
// (per spec), so refs inside that callback must count as `immediate`.
// This is a heuristic allowlist for the common cases — the general problem
// (knowing what an arbitrary receiver does with a callback) is undecidable
// by pure syntax analysis, so unknown receivers still default to deferred.
const SYNC_FIRST_ARG_METHODS = new Set([
  'forEach', 'map', 'filter', 'every', 'some',
  'find', 'findIndex', 'findLast', 'findLastIndex',
  'reduce', 'reduceRight', 'flatMap', 'sort',
]);
const SYNC_SECOND_ARG_METHODS = new Set(['replace', 'replaceAll']); // str.replace(re, fn)

function isGlobalObjectArg(a) {
  if (!a) return false;
  if (a.type === 'ThisExpression') return true; // top-level `this` === window in a classic script
  return a.type === 'Identifier' && GLOBAL_OBJS.has(a.name);
}

// `window.foo = ...` / `globalThis['foo'] = ...` declares the global `foo`.
// Returns the declared name, or null if this isn't a trackable global write.
function assignedGlobalProp(left) {
  if (left.type !== 'MemberExpression' && left.type !== 'OptionalMemberExpression') return null;
  if (left.object.type !== 'Identifier' || !GLOBAL_OBJS.has(left.object.name)) return null;
  if (!left.computed && left.property.type === 'Identifier') return left.property.name;
  if (left.computed && left.property.type === 'Literal' && typeof left.property.value === 'string') {
    return left.property.value;
  }
  return null; // dynamic key like window[x] — can't track statically
}
function collectPatternNames(pat, out) {
  if (!pat) return;
  switch (pat.type) {
    case 'Identifier': out.push(pat.name); break;
    case 'ObjectPattern':
      for (const p of pat.properties) {
        if (p.type === 'RestElement') collectPatternNames(p.argument, out);
        else collectPatternNames(p.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of pat.elements) if (el) collectPatternNames(el, out);
      break;
    case 'AssignmentPattern': collectPatternNames(pat.left, out); break;
    case 'RestElement': collectPatternNames(pat.argument, out); break;
    default: break;
  }
}

function declaredNamesOfStatement(node) {
  const names = [];
  // Unwrap `export ...` to the inner declaration (ESM fallback mode).
  let n = node;
  if (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') {
    if (!n.declaration) return names; // e.g. `export { a }` — a separate statement declares `a`
    n = n.declaration;
  }
  if (n.type === 'FunctionDeclaration' && n.id) names.push(n.id.name);
  else if (n.type === 'ClassDeclaration' && n.id) names.push(n.id.name);
  else if (n.type === 'VariableDeclaration') {
    for (const d of n.declarations) collectPatternNames(d.id, names);
  } else if (n.type === 'ImportDeclaration') {
    for (const s of n.specifiers) names.push(s.local.name);
  } else if (n.type === 'ExpressionStatement' && n.expression.type === 'AssignmentExpression'
             && n.expression.operator === '=') {
    // Direct writes to globals: `foo = ...` (implicit global) and
    // `window.foo = ...` (plugin/legacy style). Without this the write
    // declares nothing and every reader's dependency is silently invisible.
    const left = n.expression.left;
    if (left.type === 'Identifier') names.push(left.name);
    else {
      const prop = assignedGlobalProp(left);
      if (prop) names.push(prop);
    }
  } else if (n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression') {
    // `Object.assign(window, { a, b: ... })` declares globals a, b.
    const c = n.expression;
    if (c.callee.type === 'MemberExpression'
        && c.callee.object.type === 'Identifier' && c.callee.object.name === 'Object'
        && !c.callee.computed && c.callee.property.type === 'Identifier'
        && c.callee.property.name === 'assign'
        && c.arguments.length >= 2 && isGlobalObjectArg(c.arguments[0])) {
      for (let i = 1; i < c.arguments.length; i++) {
        const a = c.arguments[i];
        if (a.type !== 'ObjectExpression') continue;
        for (const p of a.properties) {
          if (p.type === 'SpreadElement') continue;
          if (!p.computed && p.key.type === 'Identifier') names.push(p.key.name);
          else if (p.key.type === 'Literal' && typeof p.key.value === 'string') names.push(p.key.value);
        }
      }
    }
  }
  return [...new Set(names)];
}

// ---------- Scope-aware free-variable walker ----------
// Returns the Set of identifier names referenced by `node` that are NOT
// bound by any enclosing scope introduced within `node` itself.
function collectFreeRefs(node) {
  const free = new Set();       // every name referenced anywhere (for clustering/grouping)
  const immediate = new Set();  // only names referenced OUTSIDE any nested function body —
                                 // i.e. code that actually runs the instant this statement runs,
                                 // as opposed to a callback that only fires later. Only these
                                 // should ever force a load-order constraint between files.
  const scopes = [{ names: new Set(), varScope: true }]; // statement root is a var-scope
  let deferDepth = 0;
  let withDepth = 0; // `with(obj)` makes every identifier dynamically resolvable — treat all refs inside as live

  // `var` (and function-level bindings) hoist to the nearest function/
  // statement-root scope; `let`/`const`/params stay in the current block.
  function bind(name, kind) {
    if (kind === 'var') {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].varScope) { scopes[i].names.add(name); return; }
      }
    }
    scopes[scopes.length - 1].names.add(name);
  }
  function isBound(name) { return scopes.some(s => s.names.has(name)); }
  function pushScope(varScope) { scopes.push({ names: new Set(), varScope: !!varScope }); }
  function popScope() { scopes.pop(); }

  function bindParams(params) {
    for (const p of params) {
      const names = [];
      collectPatternNames(p, names);
      names.forEach(bind);
    }
  }

  // A function value invoked synchronously (IIFE, Promise executor,
  // known-sync callback): its body runs NOW, so refs inside are immediate.
  function visitFunctionSync(fn) {
    pushScope(true);
    if (fn.id) bind(fn.id.name);
    bindParams(fn.params);
    if (fn.body) visit(fn.body, 'value');
    popScope();
  }

  function visit(n, ctx) {
    if (!n || typeof n.type !== 'string') return;

    switch (n.type) {
      case 'Identifier':
        if (ctx !== 'binding' && (withDepth > 0 || !isBound(n.name))) {
          free.add(n.name);
          if (withDepth > 0 || deferDepth === 0) immediate.add(n.name);
        }
        return;

      case 'FunctionDeclaration':
      case 'FunctionExpression': {
        // The declaration itself binds in the ENCLOSING scope (so a later
        // sibling call isn't misread as an external dependency); the body
        // runs later, hence deferred — unless invoked via visitFunctionSync.
        if (n.id) bind(n.id.name);
        pushScope(true);
        deferDepth++;
        if (n.id) bind(n.id.name); // named fn expr can reference itself
        bindParams(n.params);
        visit(n.body, 'value');
        deferDepth--;
        popScope();
        return;
      }
      case 'ArrowFunctionExpression': {
        pushScope(true);
        deferDepth++;
        bindParams(n.params);
        visit(n.body, 'value');
        deferDepth--;
        popScope();
        return;
      }

      case 'VariableDeclaration': {
        for (const d of n.declarations) {
          const names = [];
          collectPatternNames(d.id, names);
          names.forEach(nm => bind(nm, n.kind)); // 'var' hoists; let/const stay block-local
          if (d.init) visit(d.init, 'value');
        }
        return;
      }

      case 'VariableDeclarator': {
        const names = [];
        collectPatternNames(n.id, names);
        names.forEach(bind);
        if (n.init) visit(n.init, 'value');
        return;
      }

      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (n.id) bind(n.id.name);
        if (n.superClass) visit(n.superClass, 'value');
        for (const m of n.body.body) {
          if (m.computed) visit(m.key, 'value');
          if (m.value) visit(m.value, 'value');
          if (m.type === 'PropertyDefinition' && m.value === null) { /* nothing */ }
        }
        return;
      }

      case 'CatchClause': {
        pushScope(false);
        if (n.param) bindParams([n.param]);
        visit(n.body, 'value');
        popScope();
        return;
      }

      // Block-level scope boundaries for let/const. Without these, a
      // `let x` inside an if/for/switch/bare block leaks into the enclosing
      // scope and wrongly shadows a real outer dependency (silent miss).
      case 'BlockStatement': {
        pushScope(false);
        for (const st of n.body) visit(st, 'value');
        popScope();
        return;
      }
      case 'SwitchStatement': {
        pushScope(false); // `let` in a case-clause is scoped to the whole switch
        visit(n.discriminant, 'value');
        for (const c of n.cases) {
          if (c.test) visit(c.test, 'value');
          for (const st of c.consequent) visit(st, 'value');
        }
        popScope();
        return;
      }
      case 'StaticBlock': {
        pushScope(false);
        for (const st of n.body) visit(st, 'value');
        popScope();
        return;
      }
      case 'WithStatement': {
        visit(n.object, 'value');
        withDepth++;
        visit(n.body, 'value');
        withDepth--;
        return;
      }

      case 'CallExpression':
      case 'NewExpression': {
        // IIFE — (function(){ ... })() — runs THIS INSTANT, not later.
        if (n.type === 'CallExpression' && n.callee
            && (n.callee.type === 'FunctionExpression' || n.callee.type === 'ArrowFunctionExpression')) {
          visitFunctionSync(n.callee);
          for (const a of n.arguments) {
            if (a && a.type !== 'FunctionExpression' && a.type !== 'ArrowFunctionExpression') visit(a, 'value');
          }
          return;
        }
        // fn.call(...) / fn.apply(...) on an inline function — also synchronous.
        if (n.type === 'CallExpression' && n.callee && n.callee.type === 'MemberExpression'
            && (n.callee.object.type === 'FunctionExpression' || n.callee.object.type === 'ArrowFunctionExpression')
            && !n.callee.computed && n.callee.property.type === 'Identifier'
            && (n.callee.property.name === 'call' || n.callee.property.name === 'apply')) {
          visitFunctionSync(n.callee.object);
          for (const a of n.arguments) {
            if (a && a.type !== 'FunctionExpression' && a.type !== 'ArrowFunctionExpression') visit(a, 'value');
          }
          return;
        }
        // Known-synchronous callbacks: Promise executor, arr.map/forEach/...,
        // str.replace(re, fn), Array.from(iter, fn), JSON.stringify(v, fn).
        const syncArgs = new Set();
        if (n.type === 'NewExpression' && n.callee.type === 'Identifier'
            && n.callee.name === 'Promise' && n.arguments.length > 0) {
          syncArgs.add(n.arguments[0]);
        } else if (n.callee.type === 'MemberExpression') {
          const p = n.callee.property;
          const pname = (!n.callee.computed && p.type === 'Identifier') ? p.name : null;
          if (pname && SYNC_FIRST_ARG_METHODS.has(pname) && n.arguments.length > 0) {
            syncArgs.add(n.arguments[0]);
          }
          if (pname && SYNC_SECOND_ARG_METHODS.has(pname) && n.arguments.length > 1) {
            syncArgs.add(n.arguments[1]);
          }
          if (!n.callee.computed && n.callee.object.type === 'Identifier'
              && n.callee.object.name === 'Array' && pname === 'from' && n.arguments.length > 1) {
            syncArgs.add(n.arguments[1]);
          }
          if (!n.callee.computed && n.callee.object.type === 'Identifier'
              && n.callee.object.name === 'JSON' && pname === 'stringify' && n.arguments.length > 1) {
            syncArgs.add(n.arguments[1]);
          }
        }
        visit(n.callee, 'value');
        for (const a of n.arguments) {
          if (!a) continue;
          if (syncArgs.has(a) && (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression')) {
            visitFunctionSync(a);
          } else {
            visit(a, 'value');
          }
        }
        return;
      }

      case 'ImportDeclaration': {
        // Imported names are bindings, not references.
        for (const s of n.specifiers) bind(s.local.name);
        return;
      }
      case 'ExportNamedDeclaration': {
        if (n.declaration) visit(n.declaration, 'value');
        for (const s of n.specifiers || []) if (s.local) visit(s.local, 'value');
        return;
      }
      case 'ExportDefaultDeclaration': {
        if (n.declaration) visit(n.declaration, 'value');
        return;
      }
      case 'ExportAllDeclaration':
        return;

      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        // `window.foo` reads the global `foo` (when `window` isn't shadowed).
        // Record `foo` as a ref so it links to a `window.foo = ...` declaration.
        if (n.object.type === 'Identifier' && GLOBAL_OBJS.has(n.object.name) && !isBound(n.object.name)) {
          let prop = null;
          if (!n.computed && n.property.type === 'Identifier') prop = n.property.name;
          else if (n.computed && n.property.type === 'Literal' && typeof n.property.value === 'string') {
            prop = n.property.value;
          }
          if (prop) {
            free.add(prop);
            if (withDepth > 0 || deferDepth === 0) immediate.add(prop);
          }
        }
        visit(n.object, 'value');
        if (n.computed) visit(n.property, 'value');
        return;
      }

      case 'Property': {
        if (n.computed) visit(n.key, 'value');
        if (n.shorthand) visit(n.value, 'value');
        else visit(n.value, 'value');
        return;
      }
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        if (n.computed) visit(n.key, 'value');
        if (n.value) visit(n.value, 'value');
        return;
      }

      case 'LabeledStatement':
        visit(n.body, 'value');
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;

      case 'ForStatement': {
        pushScope(false);
        if (n.init) visit(n.init, 'value');
        if (n.test) visit(n.test, 'value');
        if (n.update) visit(n.update, 'value');
        visit(n.body, 'value');
        popScope();
        return;
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        pushScope(false);
        visit(n.left, n.left.type === 'VariableDeclaration' ? 'value' : 'value');
        visit(n.right, 'value');
        visit(n.body, 'value');
        popScope();
        return;
      }

      default:
        break;
    }

    // Generic fallback: walk all child node(s)/array-of-nodes properties.
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' ||
          key === 'range' || key === 'parent') continue;
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item.type === 'string') visit(item, 'value');
        }
      } else if (val && typeof val.type === 'string') {
        visit(val, 'value');
      }
    }
  }

  visit(node, 'value');
  return { free, immediate };
}

function isHoistedFunctionStmt(node) {
  if (node.type === 'FunctionDeclaration') return true;
  if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration')
      && node.declaration && node.declaration.type === 'FunctionDeclaration') return true;
  return false;
}

// ---------- Build top-level statement records ----------
const body = ast.program ? ast.program.body : ast.body;
const stmts = body.map((node, idx) => ({
  idx,
  node,
  start: node.start,
  end: node.end,
  isFunctionDecl: isHoistedFunctionStmt(node),
  declaredNames: declaredNamesOfStatement(node),
}));

// Attach leading comments (pure formatting nicety, not required for correctness)
const sortedComments = comments.slice().sort((a, b) => a.start - b.start);
for (let i = 0; i < stmts.length; i++) {
  const s = stmts[i];
  const prevEnd = i === 0 ? 0 : stmts[i - 1].end;
  let leadStart = s.start;
  for (let c = sortedComments.length - 1; c >= 0; c--) {
    const cm = sortedComments[c];
    if (cm.end <= prevEnd) break;
    if (cm.end <= leadStart) {
      const between = source.slice(cm.end, leadStart);
      if (/^\s*$/.test(between)) leadStart = cm.start;
    }
  }
  s.start = leadStart;
}

// declaredNames map: name -> first declaring statement index.
// NOTE: on duplicate top-level declarations (legal for `var`/`function`),
// refs resolve to the FIRST declaration — a known approximation, since which
// declaration is "in effect" at a given call site needs flow analysis.
// Duplicates are reported (console + manifest) so they don't pass silently.
const declaredAt = new Map();
const duplicateDeclarations = [];
for (const s of stmts) for (const name of s.declaredNames) {
  if (!declaredAt.has(name)) declaredAt.set(name, s.idx);
  else duplicateDeclarations.push({ name, firstStmt: declaredAt.get(name), againStmt: s.idx });
}
if (duplicateDeclarations.length) {
  console.log(`⚠ ${duplicateDeclarations.length} duplicate top-level declaration(s) — refs resolve to the first:`,
    duplicateDeclarations.map(d => `${d.name} (stmts ${d.firstStmt}, ${d.againStmt})`).join('; '));
}

// Free refs per statement, resolved to owning statement indices.
// `freeNames` = everything referenced anywhere (used for clustering).
// `immediateNames` = only refs that execute the instant this statement
// runs, i.e. NOT inside a nested function/callback (used for ordering).
for (const s of stmts) {
  const { free, immediate } = collectFreeRefs(s.node);
  s.freeNames = free;
  s.immediateNames = immediate;
}

// Usage counts, to detect "hub" globals (e.g. shared app state) that
// would otherwise weld every statement into one giant component.
const usageCount = new Map();
for (const s of stmts) {
  for (const name of s.freeNames) {
    if (!declaredAt.has(name)) continue; // external/global (window, Math, ...)
    usageCount.set(name, (usageCount.get(name) || 0) + 1);
  }
}
const hubThreshold = Math.max(6, Math.ceil(stmts.length * opts.hubRatio));
const hubNames = new Set(
  [...usageCount.entries()].filter(([, c]) => c > hubThreshold).map(([n]) => n)
);

// ---------- Build edges ----------
// clusterEdges: undirected, hub-suppressed -> used for grouping (uses ALL
//               refs, since two statements sharing a callback dependency
//               are still meaningfully related for grouping purposes)
// orderEdges:   directed (dependent -> dependency) -> used ONLY to compute
//               load order. Built from `immediateNames` alone: a reference
//               tucked inside a callback that fires later doesn't need its
//               target loaded yet, and treating it as if it did is exactly
//               what manufactures false ordering cycles between files that
//               don't actually have one.
const clusterEdges = [];
const orderEdges = []; // {from, to} meaning `from` must load at/after `to`

for (const s of stmts) {
  for (const name of s.freeNames) {
    const owner = declaredAt.get(name);
    if (owner === undefined || owner === s.idx) continue;
    if (!hubNames.has(name)) clusterEdges.push([s.idx, owner]);
  }
  if (!s.isFunctionDecl) {
    for (const name of s.immediateNames) {
      const owner = declaredAt.get(name);
      if (owner === undefined || owner === s.idx) continue;
      orderEdges.push({ from: s.idx, to: owner });
    }
  }
}

// ---------- Union-Find clustering ----------
const parent = stmts.map((_, i) => i);
function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }
for (const [a, b] of clusterEdges) union(a, b);

let clusterMap = new Map(); // root -> [stmt indices]
for (const s of stmts) {
  const r = find(s.idx);
  if (!clusterMap.has(r)) clusterMap.set(r, []);
  clusterMap.get(r).push(s.idx);
}
let clusters = [...clusterMap.values()].map(members => members.sort((a, b) => a - b));
clusters.sort((a, b) => a[0] - b[0]);

// ---------- Louvain modularity refinement for oversized clusters ----------
// Connected-components has an all-or-nothing failure mode: ONE bridging
// edge anywhere permanently welds two clusters together forever, even if
// everything else about them is unrelated. On a codebase with lots of
// moderately-shared helpers (not quite "hubs"), that tends to weld most
// of the file into one giant blob. Louvain modularity clustering can cut
// through those weak bridges instead of treating every edge as equally
// permanent, so we run it as a second pass on any cluster that grew
// past a size threshold.
function buildWeightedEdges(nodeIds) {
  const nodeSet = new Set(nodeIds);
  const weights = new Map(); // "a,b" (a<b) -> weight
  for (const [a, b] of clusterEdges) {
    if (!nodeSet.has(a) || !nodeSet.has(b)) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    weights.set(key, (weights.get(key) || 0) + 1);
  }
  return [...weights.entries()].map(([k, w]) => {
    const [a, b] = k.split(',').map(Number);
    return [a, b, w];
  });
}

// Standard Louvain (Blondel et al. 2008): local moving phase + graph
// coarsening, repeated until modularity stops improving. `nodeIds` are
// the original statement indices to partition; `edges` are [i, j, w]
// with i, j drawn from nodeIds.
function louvain(nodeIds, edges) {
  // Map original ids -> dense 0..n-1 indices for this sub-problem.
  const idx = new Map(nodeIds.map((id, i) => [id, i]));
  const n = nodeIds.length;
  let graphEdges = edges.map(([a, b, w]) => [idx.get(a), idx.get(b), w]);
  let nodeMembers = nodeIds.map(id => [id]); // which original nodes each current graph-node represents

  for (let level = 0; level < 20; level++) {
    const nn = nodeMembers.length;
    const adj = Array.from({ length: nn }, () => new Map()); // neighbor -> weight
    let selfLoop = new Array(nn).fill(0);
    for (const [a, b, w] of graphEdges) {
      if (a === b) { selfLoop[a] += w; continue; }
      adj[a].set(b, (adj[a].get(b) || 0) + w);
      adj[b].set(a, (adj[b].get(a) || 0) + w);
    }
    const degree = new Array(nn).fill(0);
    let m = 0;
    for (let i = 0; i < nn; i++) {
      let d = selfLoop[i] * 2;
      for (const w of adj[i].values()) d += w;
      degree[i] = d;
      m += selfLoop[i];
      for (const [j, w] of adj[i]) if (j > i) m += w;
    }
    if (m === 0) break; // no edges left worth optimizing

    const community = nodeMembers.map((_, i) => i);
    const commTot = degree.slice(); // sum of degrees of nodes currently in each community

    let improved = true;
    let anyMoveEver = false;
    let guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < nn; i++) {
        const ci = community[i];
        // Remove i from its community
        commTot[ci] -= degree[i];
        const neighborComms = new Map(); // commId -> weight from i into it
        for (const [j, w] of adj[i]) {
          const cj = community[j];
          neighborComms.set(cj, (neighborComms.get(cj) || 0) + w);
        }
        let bestComm = ci, bestGain = 0; // 0 = staying put costs nothing extra
        const kiInOld = neighborComms.get(ci) || 0;
        const removeGain = kiInOld / m - (commTot[ci] * degree[i]) / (2 * m * m);
        for (const [cj, kiIn] of neighborComms) {
          if (cj === ci) continue;
          const gain = (kiIn / m - (commTot[cj] * degree[i]) / (2 * m * m)) - removeGain;
          if (gain > bestGain) { bestGain = gain; bestComm = cj; }
        }
        commTot[bestComm] += degree[i];
        if (bestComm !== ci) { community[i] = bestComm; improved = true; anyMoveEver = true; }
      }
    }
    if (!anyMoveEver) break; // converged — this level made no progress, stop

    // Coarsen: build next-level graph where nodes = distinct communities
    const commIds = [...new Set(community)];
    const remap = new Map(commIds.map((c, i) => [c, i]));
    const newMembers = commIds.map(() => []);
    for (let i = 0; i < nn; i++) newMembers[remap.get(community[i])].push(...nodeMembers[i]);

    const newEdgeWeights = new Map();
    for (const [a, b, w] of graphEdges) {
      const ca = remap.get(community[a]), cb = remap.get(community[b]);
      const key = ca <= cb ? `${ca},${cb}` : `${cb},${ca}`;
      newEdgeWeights.set(key, (newEdgeWeights.get(key) || 0) + w);
    }
    graphEdges = [...newEdgeWeights.entries()].map(([k, w]) => {
      const [a, b] = k.split(',').map(Number);
      return [a, b, w];
    });
    nodeMembers = newMembers;

    if (nodeMembers.length === nn) break; // nothing coarsened further
  }

  // nodeMembers now holds the final communities as groups of original ids
  return nodeMembers;
}

const LOUVAIN_SIZE_THRESHOLD = Math.max(30, Math.ceil(stmts.length * 0.10));
{
  const refined = [];
  let splitCount = 0;
  for (const cl of clusters) {
    if (cl.length > LOUVAIN_SIZE_THRESHOLD) {
      const edges = buildWeightedEdges(cl);
      const communities = louvain(cl, edges).filter(g => g.length > 0);
      if (communities.length > 1) {
        splitCount++;
        for (const g of communities) refined.push(g.sort((a, b) => a - b));
        continue;
      }
    }
    refined.push(cl);
  }
  clusters = refined.sort((a, b) => a[0] - b[0]);
  if (splitCount) {
    console.log(`Louvain refinement split ${splitCount} oversized cluster(s) into ${clusters.length} total clusters.`);
  }
}

// ---------- Merge tiny clusters into the previous one (readability) ----------
function clusterChars(cluster) {
  return cluster.reduce((n, i) => n + (stmts[i].end - stmts[i].start), 0);
}
{
  const merged = [];
  for (const cl of clusters) {
    if (merged.length && clusterChars(cl) < opts.minChars) {
      merged[merged.length - 1] = merged[merged.length - 1].concat(cl).sort((a, b) => a - b);
    } else {
      merged.push(cl.slice());
    }
  }
  clusters = merged;
}

// map statement idx -> cluster index (after merge)
const stmtCluster = new Map();
clusters.forEach((cl, ci) => cl.forEach(i => stmtCluster.set(i, ci)));

// ---------- Topological order of clusters (anchors only enforce order) ----------
const nClusters = clusters.length;
const adj = Array.from({ length: nClusters }, () => new Set()); // to -> from  (to must precede from)
const indeg = new Array(nClusters).fill(0);
const seenEdge = new Set();
for (const e of orderEdges) {
  const cf = stmtCluster.get(e.from), ct = stmtCluster.get(e.to);
  if (cf === ct) continue;
  const key = ct + '->' + cf;
  if (seenEdge.has(key)) continue;
  seenEdge.add(key);
  adj[ct].add(cf);
  indeg[cf]++;
}

// Kahn's algorithm, tie-broken by original min-index so unrelated
// clusters keep roughly their original relative order.
const minIdx = clusters.map(cl => cl[0]);
const order = [];
const available = [];
for (let c = 0; c < nClusters; c++) if (indeg[c] === 0) available.push(c);
const inOrder = new Array(nClusters).fill(false);
let warnedCycle = false;
while (order.length < nClusters) {
  available.sort((a, b) => minIdx[a] - minIdx[b]);
  let c = available.find(x => !inOrder[x]);
  if (c === undefined) {
    // Cycle among remaining clusters (rare: e.g. mutually recursive
    // functions living with anchors on both sides). Fall back to
    // original order for whatever's left.
    warnedCycle = true;
    const remaining = [];
    for (let i = 0; i < nClusters; i++) if (!inOrder[i]) remaining.push(i);
    remaining.sort((a, b) => minIdx[a] - minIdx[b]);
    for (const r of remaining) { order.push(r); inOrder[r] = true; }
    break;
  }
  available.splice(available.indexOf(c), 1);
  inOrder[c] = true;
  order.push(c);
  for (const next of adj[c]) { indeg[next]--; if (indeg[next] === 0) available.push(next); }
}

// ---------- Naming ----------
function toKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}
function nameCluster(cl, usedNames) {
  let best = null, bestScore = -1;
  for (const i of cl) {
    for (const name of stmts[i].declaredNames) {
      const score = (usageCount.get(name) || 0);
      if (score > bestScore) { bestScore = score; best = name; }
    }
  }
  let base = best ? toKebab(best) : `section-${cl[0]}`;
  let file = base + '.js';
  let n = 2;
  while (usedNames.has(file)) { file = `${base}-${n++}.js`; }
  usedNames.add(file);
  return file;
}

// ---------- Write output ----------
// Clear stale tool output first: without this, a rerun that produces fewer
// files leaves orphaned files from the previous run lingering in outDir.
// Only removes files this tool owns (*.js, manifest.json, script-tags.html).
{
  let cleaned = 0;
  for (const f of fs.readdirSync(outDir)) {
    if (f === 'manifest.json' || f === 'script-tags.html' || f.endsWith('.js')) {
      fs.unlinkSync(path.join(outDir, f));
      cleaned++;
    }
  }
  if (cleaned) console.log(`Cleaned ${cleaned} stale file(s) from a previous run in ${outDir}.`);
}
// Reserve the loader name so no cluster file can collide with the entry point.
const usedNames = new Set();
if (opts.loader) usedNames.add(opts.loader);
const manifest = [];
for (const ci of order) {
  const cl = clusters[ci].slice().sort((a, b) => a - b);
  const fileName = nameCluster(cl, usedNames);
  const code = cl.map(i => source.slice(stmts[i].start, stmts[i].end)).join('\n\n');
  const decls = cl.flatMap(i => stmts[i].declaredNames);
  const header = `// Auto-split from ${path.basename(inputFile)}\n` +
    (decls.length ? `// Declares: ${decls.join(', ')}\n` : '') + '\n';
  fs.writeFileSync(path.join(outDir, fileName), header + code + '\n');
  manifest.push({ file: fileName, declares: decls, statementCount: cl.length });
}

// Bootstrap loader: keeps the ORIGINAL entry-point name working. Pages keep
// loading just this one file (e.g. <script src=".../app.js"></script>) exactly
// as before — it pulls in every split file below in dependency order, so no
// HTML / loader / config changes are needed anywhere else.
// Synchronous via document.write DURING PARSING on purpose: that is the only
// single-file mechanism with the same semantics as separate <script> tags —
// code running after this tag sees the same globals as the original file.
// Requirements (same as the original file had): load it with a plain
// parsing-time <script src>, not async/defer, not after page load.
// Caveat: Chrome may block document.write-injected scripts on very slow (2G)
// connections; if that matters to you, use script-tags.html instead.
if (opts.loader) {
  const loaderCode = `// Auto-generated bootstrap loader for ${path.basename(inputFile)}\n` +
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
  fs.writeFileSync(path.join(outDir, opts.loader), loaderCode);
}

fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify({
    order: manifest,
    loader: opts.loader, // single entry point; pages keep loading this file
    hubNamesSuppressed: [...hubNames],
    cycleFallback: warnedCycle,
    parserMode,
    duplicateDeclarations,
    // `node --check` on reassembled output proves SYNTAX validity only, not
    // that load order is behaviorally correct. Static analysis can miss
    // dynamic edges (see header comment); smoke-test the split pages.
    verified: 'syntax-only',
  }, null, 2)
);

const scriptTags = manifest.map(m => `<script src="${path.posix.join(path.basename(outDir), m.file)}"></script>`).join('\n');
fs.writeFileSync(path.join(outDir, 'script-tags.html'), scriptTags + '\n');

console.log(`Wrote ${manifest.length} files${opts.loader ? ` + loader ${opts.loader}` : ''} to ${outDir}`);
if (hubNames.size) console.log('Suppressed hub globals (kept, not used for clustering):', [...hubNames].join(', '));
if (warnedCycle) console.log('⚠ Dependency cycle detected between some clusters — fell back to original order for those.');
console.log('See manifest.json and script-tags.html for load order.');
