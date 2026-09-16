// lib/frontend-js.js — JavaScript frontend (acorn).
// Produces backend records: { idx, start, end, isHoisted, declaredNames,
//                             freeNames, immediateNames, getCode }
const acorn = require('acorn');

// Names that unambiguously mean "the global object" in a classic script.
const GLOBAL_OBJS = new Set(['window', 'globalThis', 'self', 'global']);

// Higher-order functions whose callback argument is invoked synchronously
// (per spec), so refs inside that callback must count as `immediate`.
// Heuristic allowlist — the general problem is undecidable by pure syntax
// analysis, so unknown receivers still default to deferred.
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

// Parse JS source into statements + comments. Throws on unparseable input.
function parseJSBlock(source) {
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
  return { body: ast.program ? ast.program.body : ast.body, comments, parserMode };
}

// Parse JS source into backend records. Throws on unparseable input.
function analyzeJS(source) {
  const { body, comments, parserMode } = parseJSBlock(source);
  return { records: buildRecords(source, body, comments), parserMode };
}

// Build records for an explicit statement list (also used by the HTML
// frontend, which pools inline <script> blocks into one list).
function buildRecords(source, body, comments) {
  const stmts = body.map((node, idx) => ({
    idx,
    node,
    start: node.start,
    end: node.end,
    isHoisted: isHoistedFunctionStmt(node),
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

  for (const s of stmts) {
    const { free, immediate } = collectFreeRefs(s.node);
    s.freeNames = free;
    s.immediateNames = immediate;
    s.getCode = () => source.slice(s.start, s.end);
  }
  return stmts;
}

module.exports = {
  analyzeJS, parseJSBlock, buildRecords, collectFreeRefs, declaredNamesOfStatement,
  GLOBAL_OBJS, SYNC_FIRST_ARG_METHODS, SYNC_SECOND_ARG_METHODS,
};
