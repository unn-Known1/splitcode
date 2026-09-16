// lib/preflight.js — pre-split risk scan, per language.
//
// Returns [{ level: 'warn'|'note', code, message }]. WARN = output may be
// wrong; NOTE = be aware. Runs automatically before every split, or alone
// via --check (no output written). AST-based, not regex — warnings must not
// fire on comments/strings.
const acorn = require('acorn');
const ts = require('typescript');
const { parse } = require('node-html-parser');
const { execFileSync } = require('child_process');

function preflight(source, lang, fileName) {
  if (lang === 'js') return preflightJS(source);
  if (lang === 'ts') return preflightTS(source, fileName);
  if (lang === 'html') return preflightHTML(source);
  if (lang === 'py') return preflightPY(source, fileName);
  return [];
}

// ---------- JS (acorn walk) ----------
function preflightJS(source) {
  const out = [];
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (e) {
    try {
      ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (e2) {
      out.push({ level: 'warn', code: 'parse-error', message: `File does not parse: ${e.message.split('\n')[0]} — fix syntax before splitting.` });
      return out;
    }
  }
  const seen = new Set();
  const once = (level, code, message) => {
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ level, code, message });
  };
  (function walk(n, funcDepth) {
    if (!n || typeof n.type !== 'string') return;
    const deeper = (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression') ? funcDepth + 1 : funcDepth;
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c.type === 'Identifier' && c.name === 'eval') {
        once('warn', 'eval', '`eval(...)` found — dependencies inside strings are invisible; edges will be missing.');
      }
      if (c.type === 'Identifier' && c.name === 'importScripts') {
        once('warn', 'import-scripts', '`importScripts(...)` found — worker load edges are invisible to ordering.');
      }
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' &&
          c.property.name === 'defineProperty' && c.object.type === 'Identifier' && c.object.name === 'Object') {
        once('warn', 'define-property', '`Object.defineProperty(...)` found — declares nothing trackable; readers link to nothing.');
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
  })(ast, 0);
  return out;
}

// ---------- TS (typescript API walk) ----------
function preflightTS(source, fileName) {
  const out = [];
  const kind = /\.tsx$/i.test(fileName || '') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName || 'input.ts', source, ts.ScriptTarget.Latest, true, kind);
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
      if (ts.isIdentifier(c) && c.text === 'importScripts') {
        once('warn', 'import-scripts', '`importScripts(...)` found — worker load edges are invisible to ordering.');
      }
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) &&
          c.expression.text === 'Object' && c.name.text === 'defineProperty') {
        once('warn', 'define-property', '`Object.defineProperty(...)` found — declares nothing trackable; readers link to nothing.');
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
  const out = [];
  let root;
  try {
    root = parse(source);
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
    const raw = execFileSync('python3', ['-c', PYWARN, fileName], { encoding: 'utf8' });
    for (const [code, level, message] of JSON.parse(raw)) {
      out.push({ level, code, message });
    }
  } catch (e) {
    // python3 missing/too old is already a friendly gate; syntax errors surface in analyze.
  }
  return out;
}

module.exports = { preflight };
