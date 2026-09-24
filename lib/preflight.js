// lib/preflight.js — pre-split risk scan, per language.
//
// Returns [{ level: 'warn'|'note', code, message }]. WARN = output may be
// wrong; NOTE = be aware. Runs automatically before every split, or alone
// via --check (no output written). AST-based, not regex — warnings must not
// fire on comments/strings.
//
// Perf: heavy parsers (typescript, node-html-parser) are required LAZILY so
// pure-JS runs never pay their import cost. When the matching frontend has
// already parsed this exact source string, its cached AST is reused instead
// of parsing a second time (see lib/frontend-{js,ts,html,py}.js).
const acorn = require('acorn');
const { execFileSync } = require('child_process');

function lazyTS() {
  try {
    return require('typescript');
  } catch (e) {
    const err = new Error(
      'TypeScript analysis needs the `typescript` package (it is an optional ' +
      'dependency). Install it (`npm i typescript@5`) and rerun — your code stays untouched.'
    );
    err.friendly = true;
    throw err;
  }
}

function lazyHTMLParser() {
  try {
    return require('node-html-parser').parse;
  } catch (e) {
    const err = new Error(
      'HTML analysis needs the `node-html-parser` package. Run `npm install` and rerun.'
    );
    err.friendly = true;
    throw err;
  }
}

function preflight(source, lang, fileName) {
  if (lang === 'js') return preflightJS(source);
  if (lang === 'ts') return preflightTS(source, fileName);
  if (lang === 'html') return preflightHTML(source);
  if (lang === 'py') return preflightPY(source, fileName);
  return [];
}

// ---------- shared helpers ----------
const TIMER_FNS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const GLOBAL_OBJS_PRE = new Set(['window', 'globalThis', 'self', 'global']);

function isStringLiteral(n) {
  return !!n && ((n.type === 'Literal' && typeof n.value === 'string') ||
    (typeof n.kind === 'number')); // TS-checked by caller via ts.isStringLiteral
}

// ---------- JS (acorn walk) ----------
function preflightJS(source) {
  const out = [];
  // Reuse the frontend's cached parse of this exact string when available.
  let body;
  try {
    const { getCachedJSParse, parseJSBlock } = require('./frontend-js');
    const cached = getCachedJSParse(source);
    if (cached) {
      body = cached.body;
    } else {
      body = parseJSBlock(source).body;
    }
  } catch (e) {
    out.push({ level: 'warn', code: 'parse-error', message: `File does not parse: ${String((e && e.message) || e).split('\n')[0]} — fix syntax before splitting.` });
    return out;
  }
  const seen = new Set();
  const once = (level, code, message) => {
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ level, code, message });
  };

  // Top-level implicit-global heuristic: bare writes the declaration
  // collector cannot see (it only understands ExpressionStatement `=` and
  // VariableDeclarations). Needs the declared set — reuse the frontend's.
  try {
    const { declaredNamesOfStatement } = require('./frontend-js');
    const declared = new Set();
    for (const st of body) for (const n of declaredNamesOfStatement(st)) declared.add(n);
    const checkTarget = (t) => {
      if (!t) return;
      if (t.type === 'Identifier' && !declared.has(t.name) && !GLOBAL_OBJS_PRE.has(t.name)) {
        once('note', 'implicit-global', `Bare write to undeclared \`${t.name}\` outside a trackable declaration (e.g. for-loop init) — readers stay unlinked; verify order manually.`);
      }
    };
    for (const st of body) {
      if (st.type === 'ForStatement' && st.init && st.init.type !== 'VariableDeclaration') {
        // init may be an assignment/sequence — walk shallow for identifiers.
        (function shallow(n) {
          if (!n || typeof n.type !== 'string') return;
          if (n.type === 'Identifier') { checkTarget(n); return; }
          if (n.type === 'AssignmentExpression') { checkTarget(n.left); shallow(n.right); return; }
          if (n.type === 'SequenceExpression') { n.expressions.forEach(shallow); return; }
          if (n.type === 'UpdateExpression') { checkTarget(n.argument); return; }
        })(st.init);
      } else if ((st.type === 'ForInStatement' || st.type === 'ForOfStatement') && st.left.type === 'Identifier') {
        checkTarget(st.left);
      }
    }
  } catch (e) { /* heuristic only — never fail the scan */ }

  // Wrap the statements in a synthetic Program node so the walker below
  // (written for full ASTs) works unchanged on cached bodies.
  (function walk(n, funcDepth) {
    if (!n || typeof n.type !== 'string') return;
    const deeper = (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression') ? funcDepth + 1 : funcDepth;
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c.type === 'Identifier' && c.name === 'eval') {
        once('warn', 'eval', '`eval(...)` found — dependencies inside strings are invisible; edges will be missing.');
      }
      // Member-form indirect eval: window.eval / globalThis.eval / obj.eval.
      if (c.type === 'MemberExpression' &&
          ((c.property.type === 'Identifier' && !c.computed && c.property.name === 'eval') ||
           (c.computed && c.property.type === 'Literal' && c.property.value === 'eval'))) {
        once('warn', 'indirect-eval', 'Member-form `X.eval(...)` found — runs as indirect eval; dependencies inside strings are invisible.');
      }
      if (c.type === 'Identifier' && c.name === 'importScripts') {
        once('warn', 'import-scripts', '`importScripts(...)` found — worker load edges are invisible to ordering.');
      }
      // self.importScripts / worker.importScripts (the normal worker usage).
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' &&
          c.property.name === 'importScripts') {
        once('warn', 'import-scripts', '`X.importScripts(...)` found — worker load edges are invisible to ordering.');
      }
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' &&
          c.property.name === 'defineProperty' && c.object.type === 'Identifier' && c.object.name === 'Object') {
        once('warn', 'define-property', '`Object.defineProperty(...)` found — declares nothing trackable; readers link to nothing.');
      }
      // setTimeout("code") / setInterval("code") — string-eval form.
      if (c.type === 'Identifier' && TIMER_FNS.has(c.name) && n.arguments.length > 0 &&
          n.arguments[0] && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string') {
        once('warn', 'string-callback', `\`${c.name}(\"...\")\` with a string argument found — compiled like eval; dependencies inside are invisible. Pass a function instead.`);
      }
      // require('...') — CJS/AMD edge, unmodeled (module id is a string, not a ref).
      if (c.type === 'Identifier' && c.name === 'require' && n.arguments.length > 0) {
        once('note', 'cjs-require', '`require(...)` found — module edges are not modeled; verify load order manually.');
      }
      // Object.assign(Target, ...) shapes.
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' &&
          c.object.name === 'Object' && c.property.type === 'Identifier' &&
          c.property.name === 'assign' && n.arguments.length >= 2) {
        const target = n.arguments[0];
        const isGlobalTarget = (target.type === 'Identifier' && GLOBAL_OBJS_PRE.has(target.name)) ||
          target.type === 'ThisExpression';
        if (isGlobalTarget) {
          for (let i = 1; i < n.arguments.length; i++) {
            const a = n.arguments[i];
            if (!a || a.type === 'SpreadElement' || a.type !== 'ObjectExpression') {
              once('warn', 'dynamic-global-key', '`Object.assign(window/globalThis, ...)` with a non-literal or spread source found — declared globals untrackable; readers stay unlinked.');
              break;
            }
          }
        } else if (target.type === 'MemberExpression') {
          // Object.assign(X.prototype, {...}) — method writes, invisible.
          const chain = [];
          let o = target, ok = true;
          while (o && o.type === 'MemberExpression') {
            if (!o.computed && o.property.type === 'Identifier') chain.unshift(o.property.name);
            else { ok = false; break; }
            o = o.object;
          }
          if (ok && chain.includes('prototype')) {
            once('warn', 'prototype-methods', '`Object.assign(X.prototype, {...})` found — prototype method writes declare nothing; readers stay unlinked.');
          }
        }
      }
    }
    if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'Function') {
      once('warn', 'new-function', '`new Function(...)` found — dynamic code is invisible to analysis.');
    }
    if (n.type === 'ImportExpression') {
      once('warn', 'dynamic-import', 'Dynamic `import(...)` found — its edge is invisible to ordering.');
    }
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
      const chain = [];
      let o = n.left, ok = true;
      while (o && o.type === 'MemberExpression') {
        if (!o.computed && o.property.type === 'Identifier') chain.unshift(o.property.name);
        else { ok = false; break; }
        o = o.object;
      }
      if (ok && chain.includes('prototype')) {
        once('warn', 'prototype-assign', '`X.prototype.y = ...` found — prototype writes declare nothing; readers stay unlinked.');
      }
      // Computed global key: window[x] = ... — untrackable, and SILENT until now.
      if (!ok && o && o.type === 'Identifier' && GLOBAL_OBJS_PRE.has(o.name)) {
        once('warn', 'dynamic-global-key', 'Computed global write (`window[...] = ...`) found — the key is untrackable statically; readers stay unlinked.');
      }
    }
    if ((n.type === 'Property' && (n.kind === 'get' || n.kind === 'set')) ||
        (n.type === 'MethodDefinition' && (n.kind === 'get' || n.kind === 'set'))) {
      once('note', 'accessor', 'Getter/setter found — treated as a plain read; hidden side-effect deps are missed.');
    }
    if (n.type === 'AwaitExpression' && funcDepth === 0) {
      once('note', 'top-level-await', 'Top-level `await` found — analyzed as immediate; module timing nuances are unmodeled.');
    }
    for (const key of Object.keys(n)) {
      if (['type', 'start', 'end', 'loc', 'range'].includes(key)) continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(w => { if (w && typeof w.type === 'string') walk(w, deeper); });
      else if (v && typeof v.type === 'string') walk(v, deeper);
    }
  })({ type: 'Program', body }, 0);
  return out;
}

// ---------- TS (typescript API walk) ----------
function preflightTS(source, fileName) {
  const ts = lazyTS();
  const out = [];
  // Reuse the frontend's cached SourceFile for this exact string when present.
  let sf;
  try {
    const { getCachedTSSourceFile } = require('./frontend-ts');
    sf = getCachedTSSourceFile(source) || ts.createSourceFile(fileName || 'input.ts', source, ts.ScriptTarget.Latest, true,
      /\.tsx$/i.test(fileName || '') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  } catch (e) {
    out.push({ level: 'warn', code: 'parse-error', message: `TypeScript parse failed: ${String((e && e.message) || e).split('\n')[0]}` });
    return out;
  }
  if ((sf.parseDiagnostics || []).length) {
    out.push({ level: 'warn', code: 'parse-error', message: 'File has syntax errors — TypeScript recovered, but records near errors may be wrong.' });
  }
  const seen = new Set();
  const once = (level, code, message) => {
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ level, code, message });
  };
  (function walk(n, funcDepth) {
    if (!n || typeof n.kind !== 'number') return;
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const deeper = (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) ? funcDepth + 1 : funcDepth;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isIdentifier(c) && c.text === 'eval') {
        once('warn', 'eval', '`eval(...)` found — dependencies inside strings are invisible; edges will be missing.');
      }
      if (ts.isPropertyAccessExpression(c) && c.name.text === 'eval') {
        once('warn', 'indirect-eval', 'Member-form `X.eval(...)` found — runs as indirect eval; dependencies inside strings are invisible.');
      }
      if (ts.isIdentifier(c) && c.text === 'importScripts') {
        once('warn', 'import-scripts', '`importScripts(...)` found — worker load edges are invisible to ordering.');
      }
      if (ts.isPropertyAccessExpression(c) && c.name.text === 'importScripts') {
        once('warn', 'import-scripts', '`X.importScripts(...)` found — worker load edges are invisible to ordering.');
      }
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) &&
          c.expression.text === 'Object' && c.name.text === 'defineProperty') {
        once('warn', 'define-property', '`Object.defineProperty(...)` found — declares nothing trackable; readers link to nothing.');
      }
      if (ts.isIdentifier(c) && TIMER_FNS.has(c.text) && n.arguments && n.arguments.length &&
          ts.isStringLiteral(n.arguments[0])) {
        once('warn', 'string-callback', `\`${c.text}("...")\` with a string argument found — compiled like eval; dependencies inside are invisible. Pass a function instead.`);
      }
      if (ts.isIdentifier(c) && c.text === 'require' && n.arguments && n.arguments.length) {
        once('note', 'cjs-require', '`require(...)` found — module edges are not modeled; verify load order manually.');
      }
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) &&
          c.expression.text === 'Object' && c.name.text === 'assign' && n.arguments && n.arguments.length >= 2) {
        const target = n.arguments[0];
        if (target && ts.isPropertyAccessExpression(target)) {
          let o = target;
          const chain = [];
          while (o && ts.isPropertyAccessExpression(o)) { chain.unshift(o.name.text); o = o.expression; }
          if (chain.includes('prototype')) {
            once('warn', 'prototype-methods', '`Object.assign(X.prototype, {...})` found — prototype method writes declare nothing; readers stay unlinked.');
          }
        }
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Function') {
      once('warn', 'new-function', '`new Function(...)` found — dynamic code is invisible to analysis.');
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      once('warn', 'dynamic-import', 'Dynamic `import(...)` found — its edge is invisible to ordering.');
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left)) {
      let o = n.left, ok = true;
      const chain = [];
      while (o && ts.isPropertyAccessExpression(o)) {
        chain.unshift(o.name.text);
        o = o.expression;
      }
      if (ok && chain.includes('prototype')) {
        once('warn', 'prototype-assign', '`X.prototype.y = ...` found — prototype writes declare nothing; readers stay unlinked.');
      }
    }
    if ((ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n))) {
      once('note', 'accessor', 'Getter/setter found — treated as a plain read; hidden side-effect deps are missed.');
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) &&
        (n.name.text === 'get' || n.name.text === 'set')) {
      // `{ get() {} }` shorthand appears as MethodDeclaration; skip — covered above.
    }
    if (n.kind === ts.SyntaxKind.AwaitExpression && funcDepth === 0) {
      once('note', 'top-level-await', 'Top-level `await` found — analyzed as immediate; module timing nuances are unmodeled.');
    }
    ts.forEachChild(n, (c) => walk(c, deeper));
  })(sf, 0);
  return out;
}

// ---------- HTML ----------
function preflightHTML(source) {
  const parse = lazyHTMLParser();
  const out = [];
  // Reuse the frontend's cached parse of this exact string when present.
  let root;
  try {
    const { getCachedHTMLParse } = require('./frontend-html');
    const cached = getCachedHTMLParse(source);
    root = cached ? cached.root : parse(source);
  } catch (e) {
    return [{ level: 'warn', code: 'parse-error', message: `HTML does not parse: ${e.message} — fix before splitting.` }];
  }
  const scripts = root.querySelectorAll('script');
  const inTemplate = root.querySelectorAll('template script');
  if (inTemplate.length) {
    out.push({ level: 'warn', code: 'template-script', message: `${inTemplate.length} <script> inside <template> found — inert scripts would be EXTRACTED and ACTIVATED as loaded files. Move or exclude them first.` });
  }
  const modules = scripts.filter(s => s.getAttribute('type') === 'module');
  if (modules.length) {
    out.push({ level: 'note', code: 'module-scripts', message: `${modules.length} <script type="module"> left in place (not pooled, not ordered).` });
  }
  return out;
}

// ---------- Python (stdlib ast via python3) ----------
// NOTE: analyzePY caches the facts for this exact file+source; preflightPY
// reuses them so Python inputs cost ONE python3 spawn per run, not two.
const PYWARN = `
import ast, json, sys
tree = ast.parse(open(sys.argv[1], encoding='utf-8').read())
warns = []
def once(code, level, message):
    if code not in [w[0] for w in warns]:
        warns.append([code, level, message])
for node in ast.walk(tree):
    if isinstance(node, ast.Call):
        f = node.func
        if isinstance(f, ast.Name) and f.id in ('eval', 'exec'):
            once('dynamic-exec', 'warn', f.id + '(...) found — dependencies inside strings are invisible.')
        if isinstance(f, ast.Attribute) and f.attr == '__import__':
            once('dynamic-import', 'warn', '__import__(...) found — its edge is invisible to ordering.')
    if isinstance(node, ast.ImportFrom):
        if node.level and node.level > 0:
            once('relative-import', 'warn', 'Relative import found — parts are exec fragments, not packages; relative imports BREAK in output.')
        if any(a.name == '*' for a in node.names):
            once('star-import', 'note', 'import * found — names untrackable; uses stay unlinked.')
    if isinstance(node, ast.ImportFrom) and node.module == '__future__':
        once('future-import', 'warn', 'from __future__ import found — it must be first in its file; if it lands mid-file in a part, output is a SyntaxError.')
    if isinstance(node, ast.Name) and node.id == '__file__':
        once('dunder-file', 'note', '__file__ found — inside parts it points at the bootstrap, not the original.')
print(json.dumps(warns))
`;

function preflightPY(source, fileName) {
  const out = [];
  try {
    const { getCachedPYFacts } = require('./frontend-py');
    const cached = getCachedPYFacts(fileName, source);
    if (cached && Array.isArray(cached.warns)) {
      for (const [code, level, message] of cached.warns) out.push({ level, code, message });
      return out;
    }
  } catch (e) { /* fall through to standalone scan */ }
  try {
    const raw = execFileSync('python3', ['-c', PYWARN, fileName], { encoding: 'utf8' });
    for (const [code, level, message] of JSON.parse(raw)) {
      out.push({ level, code, message });
    }
  } catch (e) {
    // python3 missing/too old is already a friendly gate; syntax errors surface in analyze.
  }
  return out;
}

module.exports = { preflight, isStringLiteral };
