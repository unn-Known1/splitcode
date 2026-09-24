// lib/frontend-ts.js — TypeScript frontend (typescript compiler API).
//
// Same record shape as the JS frontend, with two TS-specific rules:
//  - Type-position references (`let x: Foo`, `implements Bar`) go to `free`
//    (clustering) but NEVER `immediate`: types are erased at runtime, so they
//    can never be a load-order dependency.
//  - Value positions behave exactly like JS (IIFEs, Promise executors and the
//    same sync-callback allowlist are immediate).
// Class field initializers run at construction time (deferred); decorators,
// enum initializers, namespace bodies and static blocks run at definition
// time (immediate). `<Foo />` component tags count as value references.
// Lazily loaded: `typescript` is an optional dependency, and requiring it
// costs ~600ms — pure-JS runs must never pay that (P0-1/P0-3).
let ts = null;
function needTS() {
  if (!ts) {
    try {
      ts = require('typescript');
    } catch (e) {
      const err = new Error(
        'TypeScript support needs the `typescript` package (optional dependency). ' +
        'Install it (`npm i typescript@5`) and rerun — your code stays untouched.'
      );
      err.friendly = true;
      throw err;
    }
  }
  return ts;
}

// Same-run cache: preflightTS consults this before creating a second
// SourceFile for the same string (identity by reference — split-js.js passes
// the same `source` const to both stages). P0-2.
let lastTSParse = null;
function getCachedTSSourceFile(source) {
  return (lastTSParse && lastTSParse.source === source) ? lastTSParse.sf : null;
}

function getOrCreateSourceFile(source, fileName) {
  const cached = getCachedTSSourceFile(source);
  if (cached) return cached;
  const ts = needTS();
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  lastTSParse = { source, sf };
  return sf;
}

const { SYNC_FIRST_ARG_METHODS, SYNC_SECOND_ARG_METHODS } = require('./frontend-js');

function analyzeTS(source, fileName) {
  const sf = getOrCreateSourceFile(source, fileName);
  const ts = needTS();
  const body = sf.statements.slice();
  let parserMode = 'script';
  for (const st of body) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isExportAssignment(st)) {
      parserMode = 'module';
      break;
    }
  }

  const records = body.map((node, idx) => {
    const start = attachLead(source, node, idx === 0 ? 0 : body[idx - 1].getEnd());
    const end = node.getEnd();
    const { free, immediate } = collectTSRefs(node);
    return {
      idx, start, end,
      isHoisted: isHoistedTS(node),
      declaredNames: declaredNamesTS(node),
      freeNames: free,
      immediateNames: immediate,
      getCode: () => source.slice(start, end),
    };
  });
  return { records, parserMode };
}

function attachLead(source, node, prevEnd) {
  let lead = node.getStart();
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) || [];
  for (let c = ranges.length - 1; c >= 0; c--) {
    const cm = ranges[c];
    if (cm.end <= prevEnd) break;
    if (cm.end <= lead && /^\s*$/.test(source.slice(cm.end, lead))) lead = cm.pos;
  }
  return lead;
}

function isHoistedTS(node) {
  needTS();
  // `export function f` is still a FunctionDeclaration node (export is just
  // a modifier), so this covers exported functions too.
  return ts.isFunctionDeclaration(node);
}

function declaredNamesTS(node) {
  needTS();
  const names = [];
  let n = node;
  // Unwrap `export ...` / `export default ...`.
  if ((ts.isExportDeclaration(n) || ts.isExportAssignment(n))) {
    if (ts.isExportAssignment(n)) return names; // `export = x` — x declared elsewhere
    if (!n.exportClause || !ts.isNamedExports(n.exportClause)) return names; // `export *` / `export {}`
    return names; // `export { a }` — declared by another statement
  }
  if (ts.isFunctionDeclaration(n) && n.name) names.push(n.name.text);
  else if (ts.isClassDeclaration(n) && n.name) names.push(n.name.text);
  else if (ts.isInterfaceDeclaration(n)) names.push(n.name.text);
  else if (ts.isTypeAliasDeclaration(n)) names.push(n.name.text);
  else if (ts.isEnumDeclaration(n)) names.push(n.name.text);
  else if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) names.push(n.name.text);
  else if (ts.isVariableStatement(n)) {
    for (const d of n.declarationList.declarations) collectTSBinding(d.name, names);
  } else if (ts.isImportDeclaration(n) && n.importClause) {
    const c = n.importClause;
    if (c.name) names.push(c.name.text);
    if (c.namedBindings) {
      if (ts.isNamespaceImport(c.namedBindings)) names.push(c.namedBindings.name.text);
      else for (const e of c.namedBindings.elements) names.push(e.name.text);
    }
  } else if (ts.isImportEqualsDeclaration(n)) {
    names.push(n.name.text);
  }
  return [...new Set(names)];
}

function collectTSBinding(name, out) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      collectTSBinding(el.name, out);
    }
  }
}

function collectTSRefs(node) {
  needTS();
  const free = new Set();
  const immediate = new Set();
  const scopes = [{ names: new Set(), varScope: true }];
  let deferDepth = 0;
  let inType = 0; // >0 while visiting type positions (free-only: erased at runtime)

  function bind(name, kind) {
    if (kind === 'var') {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].varScope) { scopes[i].names.add(name); return; }
      }
    }
    scopes[scopes.length - 1].names.add(name);
  }
  function isBound(name) { return scopes.some(s => s.names.has(name)); }
  function pushScope(v) { scopes.push({ names: new Set(), varScope: !!v }); }
  function popScope() { scopes.pop(); }
  function ref(name) {
    if (isBound(name)) return;
    free.add(name);
    if (inType === 0 && deferDepth === 0) immediate.add(name);
  }
  function visitType(t) {
    if (!t) return;
    inType++;
    visit(t);
    inType--;
  }
  function bindTypeParams(tps) {
    for (const tp of tps || []) bind(tp.name.text);
  }
  function bindBinding(name) {
    const out = [];
    collectTSBinding(name, out);
    out.forEach(b => bind(b));
  }
  // Decorators run at definition time (immediate). API drift guard:
  // newer TS exposes ts.getDecorators, older keeps them in modifiers.
  function decoratorsOf(n) {
    if (typeof ts.getDecorators === 'function') {
      const ds = ts.getDecorators(n);
      if (ds) return ds.slice ? ds.slice() : [...ds];
    }
    return (n.modifiers || []).filter(ts.isDecorator);
  }
  function visitDecorators(n) {
    for (const d of decoratorsOf(n)) visit(d);
  }
  // Parameter defaults evaluate at CALL time → deferred like the body.
  function visitFunctionLike(n, bodyVisit) {
    if (n.name && ts.isIdentifier(n.name)) bind(n.name.text);
    pushScope(true);
    deferDepth++;
    bindTypeParams(n.typeParameters);
    for (const p of n.parameters || []) {
      bindBinding(p.name);
      if (p.type) visitType(p.type);
    }
    for (const p of n.parameters || []) {
      if (p.initializer) visit(p.initializer); // deferred (call time)
    }
    if (n.type) visitType(n.type);
    if (bodyVisit) bodyVisit();
    deferDepth--;
    popScope();
  }
  function visitFunctionSyncLike(fn) {
    // IIFE / sync callback: body runs NOW.
    pushScope(true);
    if (fn.name && ts.isIdentifier(fn.name)) bind(fn.name.text);
    bindTypeParams(fn.typeParameters);
    for (const p of fn.parameters || []) {
      bindBinding(p.name);
      if (p.type) visitType(p.type);
      if (p.initializer) visit(p.initializer);
    }
    if (fn.type) visitType(fn.type);
    if (fn.body) visit(fn.body);
    popScope();
  }
  // Unwrap (fn) so IIFE / .call detection sees through parentheses.
  function unwrapParens(n) {
    while (n && ts.isParenthesizedExpression(n)) n = n.expression;
    return n;
  }
  function calleeName(call) {
    const c = unwrapParens(call.expression);
    if (c && ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.name)) return c.name.text;
    return null;
  }

  function visit(n) {
    if (!n || typeof n.kind !== 'number') return;

    // JSDoc: only type expressions count (as types); @param names etc. are not refs.
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) {
      ts.forEachChild(n, (c) => {
        if (c.kind >= ts.SyntaxKind.FirstTypeNode && c.kind <= ts.SyntaxKind.LastTypeNode) visitType(c);
        else if (ts.isJSDocTypeExpression(c)) visitType(c.type);
      });
      return;
    }

    if (ts.isIdentifier(n)) { ref(n.text); return; }
    if (ts.isParenthesizedExpression(n)) { visit(n.expression); return; }

    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) {
      if (!n.body) { // overload signature / ambient: declares only
        if (n.name && ts.isIdentifier(n.name)) bind(n.name.text);
        return;
      }
      visitDecorators(n);
      visitFunctionLike(n, () => visit(n.body));
      return;
    }
    if (ts.isArrowFunction(n)) {
      visitFunctionLike(n, () => visit(n.body));
      return;
    }
    if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) ||
        ts.isConstructorDeclaration(n)) {
      visitDecorators(n);
      if (n.name && ts.isComputedPropertyName(n.name)) visit(n.name.expression);
      visitFunctionLike(n, () => { if (n.body) visit(n.body); });
      return;
    }
    if (ts.isMethodSignature(n)) { // in interfaces: types only
      if (n.name && ts.isComputedPropertyName(n.name)) visit(n.name.expression);
      pushScope(true);
      bindTypeParams(n.typeParameters);
      for (const p of n.parameters || []) { bindBinding(p.name); if (p.type) visitType(p.type); }
      if (n.type) visitType(n.type);
      popScope();
      return;
    }
    if (ts.isVariableStatement(n)) {
      const kind = (n.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) ? 'let' : 'var';
      for (const d of n.declarationList.declarations) {
        bindBinding(d.name);
        if (d.type) visitType(d.type);
        if (d.initializer) visit(d.initializer);
      }
      return;
    }
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      if (n.name && ts.isIdentifier(n.name)) bind(n.name.text);
      bindTypeParams(n.typeParameters);
      visitDecorators(n); // run at definition
      for (const h of n.heritageClauses || []) {
        for (const t of h.types) {
          visit(t.expression); // `extends Expr` runs now
          for (const ta of t.typeArguments || []) visitType(ta);
        }
      }
      for (const m of n.members) {
        if (ts.isPropertyDeclaration(m)) {
          visitDecorators(m);
          if (m.name && ts.isComputedPropertyName(m.name)) visit(m.name.expression);
          if (m.type) visitType(m.type);
          if (m.initializer) { // field init runs at CONSTRUCTION (deferred)
            pushScope(true); deferDepth++; visit(m.initializer); deferDepth--; popScope();
          }
        } else if (ts.isClassStaticBlockDeclaration(m)) {
          visit(m.body); // static block runs at definition (immediate)
        } else {
          visit(m); // methods / constructors (deferred via visitFunctionLike)
        }
      }
      return;
    }
    if (ts.isInterfaceDeclaration(n)) {
      pushScope(true);
      bindTypeParams(n.typeParameters);
      for (const h of n.heritageClauses || []) {
        for (const t of h.types) { visitType(t.expression); for (const ta of t.typeArguments || []) visitType(ta); }
      }
      for (const m of n.members) visit(m);
      popScope();
      return;
    }
    if (ts.isTypeAliasDeclaration(n)) {
      pushScope(true);
      bindTypeParams(n.typeParameters);
      visitType(n.type);
      popScope();
      return;
    }
    if (ts.isEnumDeclaration(n)) {
      visitDecorators(n);
      for (const m of n.members) {
        if (m.initializer) visit(m.initializer); // runs at enum creation
      }
      return;
    }
    if (ts.isModuleDeclaration(n)) {
      // Namespace bodies execute immediately at creation.
      pushScope(false);
      if (n.body) visit(n.body);
      popScope();
      return;
    }
    if (ts.isModuleBlock(n)) {
      pushScope(false);
      ts.forEachChild(n, visit);
      popScope();
      return;
    }
    if (ts.isBlock(n)) {
      pushScope(false);
      ts.forEachChild(n, visit);
      popScope();
      return;
    }
    if (ts.isCaseBlock(n) || ts.isSwitchStatement(n)) {
      pushScope(false);
      ts.forEachChild(n, visit);
      popScope();
      return;
    }
    if (ts.isCatchClause(n)) {
      pushScope(false);
      if (n.variableDeclaration) bindBinding(n.variableDeclaration.name);
      visit(n.block);
      popScope();
      return;
    }
    if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) {
      pushScope(false);
      ts.forEachChild(n, visit);
      popScope();
      return;
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const fn = unwrapParens(n.expression);
      const isIIFE = ts.isFunctionExpression(fn) || ts.isArrowFunction(fn);
      const fnObj = ts.isPropertyAccessExpression(fn) ? unwrapParens(fn.expression) : null;
      const isCallApply = !!fnObj &&
        (ts.isFunctionExpression(fnObj) || ts.isArrowFunction(fnObj)) &&
        (fn.name.text === 'call' || fn.name.text === 'apply');
      if (isIIFE) {
        visitFunctionSyncLike(fn);
        for (const a of n.arguments || []) {
          if (!ts.isFunctionExpression(a) && !ts.isArrowFunction(a)) visit(a);
        }
        return;
      }
      if (isCallApply) {
        visitFunctionSyncLike(fnObj);
        for (const a of n.arguments || []) {
          if (!ts.isFunctionExpression(a) && !ts.isArrowFunction(a)) visit(a);
        }
        return;
      }
      const sync = new Set();
      if (ts.isNewExpression(n) && ts.isIdentifier(fn) && fn.text === 'Promise' && n.arguments && n.arguments.length) {
        sync.add(n.arguments[0]);
      } else {
        const pname = calleeName(n);
        if (pname && SYNC_FIRST_ARG_METHODS.has(pname) && n.arguments && n.arguments.length) sync.add(n.arguments[0]);
        if (pname && SYNC_SECOND_ARG_METHODS.has(pname) && n.arguments && n.arguments.length > 1) sync.add(n.arguments[1]);
        if (pname === 'from' && ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression) &&
            fn.expression.text === 'Array' && n.arguments && n.arguments.length > 1) sync.add(n.arguments[1]);
        if (pname === 'stringify' && ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression) &&
            fn.expression.text === 'JSON' && n.arguments && n.arguments.length > 1) sync.add(n.arguments[1]);
      }
      visit(fn);
      for (const a of n.arguments || []) {
        if (sync.has(a) && (ts.isFunctionExpression(a) || ts.isArrowFunction(a))) visitFunctionSyncLike(a);
        else visit(a);
      }
      for (const ta of n.typeArguments || []) visitType(ta);
      return;
    }
    if (ts.isPropertyAccessExpression(n)) { visit(n.expression); return; } // .name is not a ref
    if (ts.isPropertyAssignment(n)) {
      if (ts.isComputedPropertyName(n.name)) visit(n.name.expression);
      visit(n.initializer);
      return;
    }
    // Type-literal members: names are labels, not refs — only types count.
    if (ts.isPropertySignature(n)) {
      if (n.name && ts.isComputedPropertyName(n.name)) visit(n.name.expression);
      if (n.type) visitType(n.type);
      return;
    }
    if (ts.isIndexSignatureDeclaration(n)) {
      for (const p of n.parameters) if (p.type) visitType(p.type);
      if (n.type) visitType(n.type);
      return;
    }
    if (ts.isFunctionTypeNode(n) || ts.isConstructorTypeNode(n) || ts.isCallSignatureDeclaration(n) ||
        ts.isConstructSignatureDeclaration(n)) {
      pushScope(true);
      bindTypeParams(n.typeParameters);
      for (const p of n.parameters || []) {
        bindBinding(p.name);
        if (p.type) visitType(p.type);
      }
      if (n.type) visitType(n.type);
      popScope();
      return;
    }
    if (ts.isShorthandPropertyAssignment(n)) { ref(n.name.text); return; }
    if (ts.isLabeledStatement(n)) { visit(n.statement); return; }
    if (ts.isBreakOrContinueStatement(n)) return; // label is not a ref
    if (ts.isQualifiedName(n)) { visit(n.left); return; } // right side is member-like
    if (ts.isTypeQueryNode(n)) { visit(n.exprName); return; } // `typeof foo` is a VALUE ref
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      if (c) {
        if (c.name) bind(c.name.text);
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) bind(c.namedBindings.name.text);
          else for (const e of c.namedBindings.elements) bind(e.name.text);
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) { bind(n.name.text); return; }
    if (ts.isExportDeclaration(n)) {
      if (n.exportClause && ts.isNamedExports(n.exportClause) && !n.moduleSpecifier) {
        for (const e of n.exportClause.elements) visit(e.propertyName || e.name);
      }
      return;
    }
    if (ts.isExportAssignment(n)) { visit(n.expression); return; }
    // JSX: <Foo /> references the component; lowercase tags are intrinsics.
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      visitJsxTag(n.tagName);
      for (const a of n.attributes.properties) visit(a);
      return;
    }
    if (ts.isJsxAttribute(n)) {
      if (n.initializer && !ts.isStringLiteral(n.initializer)) visit(n.initializer);
      return;
    }
    if (ts.isJsxExpression(n)) { if (n.expression) visit(n.expression); return; }

    ts.forEachChild(n, visit);
  }

  function visitJsxTag(tag) {
    if (ts.isIdentifier(tag)) {
      if (/^[A-Z]/.test(tag.text)) ref(tag.text);
    } else if (ts.isPropertyAccessExpression(tag)) {
      visit(tag.expression);
    }
  }

  visit(node);
  return { free, immediate };
}

module.exports = { analyzeTS, getCachedTSSourceFile, needTS, declaredNamesTS, collectTSRefs };
