#!/usr/bin/env python3
"""pyfacts.py — Python frontend facts extractor (stdlib ast only).

Usage: python3 pyfacts.py <file.py>
Prints JSON: {"records": [{start:[line,col], end:[line,col],
                            declared:[], free:[], immediate:[], isHoisted}],
               "mode": "script", "warns": [[code, level, message], ...]}
(records + preflight warnings in ONE spawn — see collect_warns).

Semantics mirror the JS walker:
  free       = every name referenced anywhere (clustering).
  immediate  = refs executing the instant the statement runs, i.e. outside
               any nested def/lambda (ordering).
  isHoisted  = True for def statements (a def's own body runs later, so its
               own refs never force load order — any top-level immediate
               CALL still creates the edge from the caller side).
Def-time evaluations (decorators, defaults, annotations, bases, enum-style
class bodies) count as immediate. Class bodies execute at creation, so they
are visited at the current depth; methods defer. Nested functions cannot see
class-scope names (Python scoping), so class frames are skipped past a
function boundary. `global`/`nonlocal` names are never bound locally.
"""
import ast
import json
import sys


class Collector(ast.NodeVisitor):
    def __init__(self):
        self.free = set()
        self.immediate = set()
        self.scopes = [{'names': set(), 'class': False}]
        self.defer = 0
        self.func_depth = 0
        self.no_bind = set()  # global/nonlocal names of current function

    # -- scope helpers --
    def bind(self, name):
        if name in self.no_bind:
            self.ref(name)
            return
        self.scopes[-1]['names'].add(name)

    def is_bound(self, name):
        skip_class = self.func_depth > 0
        for fr in reversed(self.scopes):
            if fr['class'] and skip_class:
                continue
            if name in fr['names']:
                return True
        return False

    def ref(self, name):
        if self.is_bound(name):
            return
        self.free.add(name)
        if self.defer == 0:
            self.immediate.add(name)

    def bind_target(self, t):
        if isinstance(t, ast.Name):
            self.bind(t.id)
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                self.bind_target(e)
        elif isinstance(t, ast.Starred):
            self.bind_target(t.value)
        # Attribute/Subscript stores are member writes, not bindings.

    def collect_globals(self, node):
        out = set()
        for child in ast.walk(node):
            if isinstance(child, (ast.Global, ast.Nonlocal)):
                out.update(child.names)
        return out

    # -- statements --
    def visit_FunctionDef(self, node):
        self._visit_def(node, is_async=isinstance(node, ast.AsyncFunctionDef))

    visit_AsyncFunctionDef = visit_FunctionDef

    def _visit_def(self, node, is_async):
        for d in node.decorator_list:      # run at def time
            self.visit(d)
        a = node.args
        for d in list(a.defaults) + list(a.kw_defaults):
            if d is not None:
                self.visit(d)              # defaults evaluate at def time
        if node.returns is not None:
            self.visit(node.returns)       # annotations evaluate at def time
        self.scopes.append({'names': set(), 'class': False})
        saved_no_bind = self.no_bind
        self.no_bind = self.collect_globals(node)
        for arg in list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs):
            self.bind(arg.arg)
            if arg.annotation is not None:
                self.visit(arg.annotation)
        if a.vararg:
            self.bind(a.vararg.arg)
        if a.kwarg:
            self.bind(a.kwarg.arg)
        self.defer += 1
        self.func_depth += 1
        for st in node.body:
            self.visit(st)
        self.func_depth -= 1
        self.defer -= 1
        self.no_bind = saved_no_bind
        self.scopes.pop()

    def visit_Lambda(self, node):
        a = node.args
        self.scopes.append({'names': set(), 'class': False})
        saved_no_bind = self.no_bind
        self.no_bind = self.collect_globals(node)
        for arg in list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs):
            self.bind(arg.arg)
        if a.vararg:
            self.bind(a.vararg.arg)
        if a.kwarg:
            self.bind(a.kwarg.arg)
        self.defer += 1
        self.func_depth += 1
        self.visit(node.body)
        self.func_depth -= 1
        self.defer -= 1
        self.no_bind = saved_no_bind
        self.scopes.pop()

    def visit_ClassDef(self, node):
        for d in node.decorator_list:
            self.visit(d)
        for b in node.bases:
            self.visit(b)
        for kw in node.keywords:
            self.visit(kw.value)
        self.scopes.append({'names': set(), 'class': True})
        for st in node.body:               # class body runs at creation
            self.visit(st)
        self.scopes.pop()

    def visit_Assign(self, node):
        self.visit(node.value)             # RHS first: x = x + 1 reads outer x
        for t in node.targets:
            self.bind_target(t)

    def visit_AnnAssign(self, node):
        if node.annotation is not None:
            self.visit(node.annotation)
        if node.value is not None:
            self.visit(node.value)
        self.bind_target(node.target)

    def visit_AugAssign(self, node):
        self.visit(node.target)            # x += 1 reads x (Store ctx, but a use)
        self.visit(node.value)

    def visit_NamedExpr(self, node):
        self.visit(node.value)
        self.bind_target(node.target)

    def visit_For(self, node):
        self._visit_for(node)

    visit_AsyncFor = visit_For

    def _visit_for(self, node):
        self.visit(node.iter)
        self.bind_target(node.target)
        for st in list(node.body) + list(node.orelse):
            self.visit(st)

    def visit_While(self, node):
        self.generic_visit(node)

    def visit_With(self, node):
        self._visit_with(node)

    visit_AsyncWith = visit_With

    def _visit_with(self, node):
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self.bind_target(item.optional_vars)
        for st in node.body:
            self.visit(st)

    def visit_Import(self, node):
        for al in node.names:
            self.bind(al.asname if al.asname else al.name.split('.')[0])

    def visit_ImportFrom(self, node):
        for al in node.names:
            if al.name == '*':
                continue                   # untrackable; uses stay free refs
            self.bind(al.asname if al.asname else al.name)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Store):
            self.bind(node.id)
        else:
            self.ref(node.id)              # Load + Del both count as uses

    def visit_Global(self, node):
        pass                               # handled via pre-scan

    visit_Nonlocal = visit_Global

    # comprehensions: own scope, targets bound, everything visited inside
    def _visit_comp(self, node, elt_fields):
        self.scopes.append({'names': set(), 'class': False})
        for gen in node.generators:
            self.visit(gen.iter)
            self.bind_target(gen.target)
            for cond in gen.ifs:
                self.visit(cond)
        for f in elt_fields:
            self.visit(f)
        self.scopes.pop()

    def visit_ListComp(self, node):
        self._visit_comp(node, [node.elt])

    def visit_SetComp(self, node):
        self._visit_comp(node, [node.elt])

    def visit_GeneratorExp(self, node):
        self._visit_comp(node, [node.elt])

    def visit_DictComp(self, node):
        self._visit_comp(node, [node.key, node.value])

    def visit_Match(self, node):
        self.visit(node.subject)
        for case in node.cases:
            self._visit_pattern(case.pattern)
            if case.guard is not None:
                self.visit(case.guard)
            for st in case.body:
                self.visit(st)

    def _visit_pattern(self, node):
        if isinstance(node, ast.MatchValue):
            self.visit(node.value)
        elif isinstance(node, ast.MatchSingleton):
            pass
        elif isinstance(node, ast.MatchSequence):
            for p in node.patterns:
                self._visit_pattern(p)
        elif isinstance(node, ast.MatchMapping):
            for p in node.patterns:
                self._visit_pattern(p)
            for p in node.keys:
                self.visit(p)
            if node.rest:
                self.bind(node.rest)
        elif isinstance(node, ast.MatchClass):
            self.visit(node.cls)
            for p in node.patterns:
                self._visit_pattern(p)
            for p in node.kwd_patterns:
                self._visit_pattern(p)
        elif isinstance(node, ast.MatchStar):
            if node.name:
                self.bind(node.name)
        elif isinstance(node, ast.MatchAs):
            if node.pattern is not None:
                self._visit_pattern(node.pattern)
            if node.name:
                self.bind(node.name)
        elif isinstance(node, ast.MatchOr):
            for p in node.patterns:
                self._visit_pattern(p)


def top_declared(node):
    """Names a top-level statement binds at module scope."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [node.name]
    if isinstance(node, ast.Assign):
        out = []
        for t in node.targets:
            collect_target_names(t, out)
        return out
    if isinstance(node, ast.AnnAssign):
        out = []
        collect_target_names(node.target, out)
        return out
    if isinstance(node, ast.Import):
        return [al.asname if al.asname else al.name.split('.')[0] for al in node.names]
    if isinstance(node, ast.ImportFrom):
        return [(al.asname if al.asname else al.name) for al in node.names if al.name != '*']
    if isinstance(node, (ast.For, ast.AsyncFor)):
        out = []
        collect_target_names(node.target, out)
        return out
    if isinstance(node, (ast.With, ast.AsyncWith)):
        out = []
        for item in node.items:
            if item.optional_vars is not None:
                collect_target_names(item.optional_vars, out)
        return out
    return []


def collect_target_names(t, out):
    if isinstance(t, ast.Name):
        out.append(t.id)
    elif isinstance(t, (ast.Tuple, ast.List)):
        for e in t.elts:
            collect_target_names(e, out)
    elif isinstance(t, ast.Starred):
        collect_target_names(t.value, out)


def span(source_lines, node):
    """Start/end [line, col] for a statement. Decorators need care: the
    decorator EXPRESSION's position excludes the `@` itself (and CPython
    pairs the decorator's line with a post-@ column), so scan back to `@`
    on the same line — otherwise output emits `traced` instead of `@traced`
    and silently changes semantics."""
    start = [node.lineno, node.col_offset]
    for d in getattr(node, 'decorator_list', []):
        text = source_lines[d.lineno - 1] if 0 < d.lineno <= len(source_lines) else ''
        at = text.rfind('@', 0, d.col_offset)
        dstart = [d.lineno, at if at >= 0 else max(0, d.col_offset - 1)]
        if dstart < start:
            start = dstart
    return start, [node.end_lineno, node.end_col_offset]


def collect_warns(tree):
    """Preflight warnings in the same pass (single python3 spawn per run).

    Codes mirror lib/preflight.js PYWARN: [code, level, message].
    """
    warns = []

    def once(code, level, message):
        if code not in [w[0] for w in warns]:
            warns.append([code, level, message])

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name) and f.id in ('eval', 'exec'):
                once('dynamic-exec', 'warn',
                     f.id + '(...) found — dependencies inside strings are invisible.')
            if isinstance(f, ast.Attribute) and f.attr == '__import__':
                once('dynamic-import', 'warn',
                     '__import__(...) found — its edge is invisible to ordering.')
        if isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                once('relative-import', 'warn',
                     'Relative import found — parts are exec fragments, not packages; '
                     'relative imports BREAK in output.')
            if any(a.name == '*' for a in node.names):
                once('star-import', 'note',
                     'import * found — names untrackable; uses stay unlinked.')
        if isinstance(node, ast.ImportFrom) and node.module == '__future__':
            once('future-import', 'warn',
                 'from __future__ import found — it must be first in its file; '
                 'if it lands mid-file in a part, output is a SyntaxError.')
        if isinstance(node, ast.Name) and node.id == '__file__':
            once('dunder-file', 'note',
                 '__file__ found — inside parts it points at the bootstrap, not the original.')
    return warns


def main():
    with open(sys.argv[1], encoding='utf-8') as fh:
        source = fh.read()
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        print(f'syntax error: {e}', file=sys.stderr)
        sys.exit(2)
    source_lines = source.split('\n')
    records = []
    for node in tree.body:
        c = Collector()
        c.visit(node)
        start, end = span(source_lines, node)
        records.append({
            'start': start,
            'end': end,
            'declared': sorted(set(top_declared(node))),
            'free': sorted(c.free),
            'immediate': sorted(c.immediate),
            'isHoisted': isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)),
        })
    print(json.dumps({'records': records, 'mode': 'script', 'warns': collect_warns(tree)}))


if __name__ == '__main__':
    main()
