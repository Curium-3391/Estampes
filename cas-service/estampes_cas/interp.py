"""estampes.math-ast/1 -> SymPy. Only allowlisted node kinds and function
names are mapped; anything else is rejected before any computation."""
import math

import sympy as sp

from .limits import LIMITS, CasError

TRIG_DEG = {"sin", "cos", "tan", "sec", "csc", "cot"}
FN = {
    "sin": sp.sin, "cos": sp.cos, "tan": sp.tan, "sec": sp.sec, "csc": sp.csc, "cot": sp.cot,
    "asin": sp.asin, "acos": sp.acos, "atan": sp.atan, "acot": sp.acot, "atan2": sp.atan2,
    "arcsin": sp.asin, "arccos": sp.acos, "arctan": sp.atan,
    "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh, "asinh": sp.asinh, "acosh": sp.acosh, "atanh": sp.atanh,
    "exp": sp.exp, "ln": sp.log, "sqrt": sp.sqrt, "abs": sp.Abs, "sign": sp.sign,
    "floor": sp.floor, "ceil": sp.ceiling, "gamma": sp.gamma, "re": sp.re, "im": sp.im,
    "conjugate": sp.conjugate, "arg": sp.arg, "binomial": sp.binomial, "gcd": sp.gcd, "lcm": sp.lcm, "mod": sp.Mod,
}
CONST = {"pi": sp.pi, "e": sp.E, "I": sp.I, "oo": sp.oo, "nan": sp.nan}
ASSUMPTIONS = {"real", "positive", "negative", "nonnegative", "nonpositive", "integer", "rational", "nonzero", "complex"}
REL = {"=": sp.Eq, "!=": sp.Ne, "<": sp.Lt, "<=": sp.Le, ">": sp.Gt, ">=": sp.Ge}
NAME_OK = lambda n: isinstance(n, str) and 0 < len(n) <= 24


class Context:
    """Notebook environment: assumptions, definitions, angle mode."""

    def __init__(self, env=None, angle="rad"):
        env = env or {}
        self.angle = angle if angle in ("rad", "deg") else "rad"
        self.assume = {}
        for name, flags in (env.get("assumptions") or {}).items():
            if NAME_OK(name) and isinstance(flags, list):
                self.assume[name] = {f: True for f in flags if f in ASSUMPTIONS}
        self.defs = {}
        for name, d in list((env.get("definitions") or {}).items())[: LIMITS.max_defs]:
            if NAME_OK(name) and isinstance(d, dict) and isinstance(d.get("body"), dict):
                self.defs[name] = {"params": [p for p in d.get("params", []) if NAME_OK(p)][:8], "body": d["body"]}
        self.symbols = {}
        self.warnings = []
        self.nodes = 0
        self.stack = []

    def symbol(self, name):
        if name not in self.symbols:
            if len(self.symbols) >= LIMITS.max_symbols:
                raise CasError("resource_limit", "more than %d different symbols" % LIMITS.max_symbols)
            self.symbols[name] = sp.Symbol(name, **self.assume.get(name, {}))
        return self.symbols[name]

    def warn(self, text):
        if text not in self.warnings:
            self.warnings.append(text)


def _int(s):
    s = str(s)
    if len(s.lstrip("-")) > LIMITS.max_int_digits:
        raise CasError("resource_limit", "integer is too large")
    return sp.Integer(int(s))


def _numeric(e):
    return not e.free_symbols


def _check_pow(base, exp):
    if base.is_Integer and exp.is_Integer and abs(base) > 1:
        bits = abs(int(exp)) * math.log2(abs(int(base)) + 1)
        if bits > LIMITS.max_pow_bits:
            raise CasError("resource_limit", "that power is too large to compute")
    if base.is_Rational and exp.is_Integer and not base.is_Integer:
        bits = abs(int(exp)) * (math.log2(abs(base.p) + 1) + math.log2(base.q + 1))
        if bits > LIMITS.max_pow_bits:
            raise CasError("resource_limit", "that power is too large to compute")


def to_sympy(n, ctx, depth=0):
    if depth > LIMITS.max_depth:
        raise CasError("resource_limit", "expression is too deep")
    ctx.nodes += 1
    if ctx.nodes > LIMITS.max_nodes * 4:
        raise CasError("resource_limit", "expression is too complex")
    if not isinstance(n, dict):
        raise CasError("syntax", "invalid math AST")
    k = n.get("node")
    rec = lambda x: to_sympy(x, ctx, depth + 1)
    if k == "integer":
        return _int(n.get("value"))
    if k == "rational":
        den = _int(n.get("den"))
        if den == 0:
            raise CasError("domain", "division by zero")
        return sp.Rational(_int(n.get("num")), den)
    if k == "float":
        try:
            return sp.Float(str(n.get("value"))[:200], LIMITS.max_precision)
        except Exception:
            raise CasError("syntax", "bad number")
    if k == "constant":
        if n.get("name") not in CONST:
            raise CasError("unsupported", "unknown constant")
        return CONST[n["name"]]
    if k == "symbol":
        name = n.get("name")
        if not NAME_OK(name) or name.startswith("_"):
            raise CasError("syntax", "bad symbol name")
        d = ctx.defs.get(name)
        if d is not None and not d["params"]:
            return _expand_def(name, d, [], ctx, depth)
        return ctx.symbol(name)
    if k == "add":
        return sp.Add(*[rec(a) for a in _args(n)])
    if k == "mul":
        return sp.Mul(*[rec(a) for a in _args(n)])
    if k == "neg":
        return -rec(n.get("arg"))
    if k == "div":
        b = rec(n.get("right"))
        if b == 0:
            raise CasError("domain", "division by zero")
        return rec(n.get("left")) / b
    if k == "pow":
        base, exp = rec(n.get("left")), rec(n.get("right"))
        _check_pow(base, exp)
        return base ** exp
    if k == "rel":
        op = n.get("op")
        if op not in REL:
            raise CasError("unsupported", "unknown relation")
        return REL[op](rec(n.get("left")), rec(n.get("right")), evaluate=False)
    if k == "list":
        items = n.get("items")
        if not isinstance(items, list) or len(items) > 64:
            raise CasError("resource_limit", "list too long")
        return [rec(i) for i in items]
    if k == "matrix":
        return _matrix([[rec(c) for c in r] for r in n.get("rows", [])])
    if k == "call":
        return _call(n, ctx, depth)
    raise CasError("unsupported", "unsupported node %r" % str(k)[:30])


def _args(n):
    a = n.get("args")
    if not isinstance(a, list) or not a or len(a) > 256:
        raise CasError("syntax", "invalid arguments")
    return a


def _matrix(rows):
    if not rows or not isinstance(rows, list):
        raise CasError("syntax", "empty matrix")
    if rows and not isinstance(rows[0], list):
        rows = [[x] for x in rows]
    m, nn = len(rows), len(rows[0])
    if m > LIMITS.max_matrix or nn > LIMITS.max_matrix:
        raise CasError("resource_limit", "matrices are limited to %dx%d" % (LIMITS.max_matrix, LIMITS.max_matrix))
    if any(len(r) != nn for r in rows):
        raise CasError("syntax", "matrix rows must have the same length")
    return sp.Matrix(rows)


def _expand_def(name, d, args, ctx, depth):
    if name in ctx.stack or len(ctx.stack) > 8:
        raise CasError("domain", "definition of %s refers to itself" % name)
    if len(args) != len(d["params"]):
        raise CasError("syntax", "%s takes %d argument(s)" % (name, len(d["params"])))
    ctx.stack.append(name)
    try:
        body = to_sympy(d["body"], ctx, depth + 1)
    finally:
        ctx.stack.pop()
    if args:
        body = body.subs({ctx.symbol(p): a for p, a in zip(d["params"], args)}, simultaneous=True)
    return body


def _call(n, ctx, depth):
    fn = n.get("fn")
    args = [to_sympy(a, ctx, depth + 1) for a in _args(n)]
    if n.get("user") or fn in ctx.defs:
        d = ctx.defs.get(fn)
        if d is None:
            raise CasError("unsupported", "unknown function %s" % str(fn)[:30])
        return _expand_def(fn, d, args, ctx, depth)
    if fn in ("matrix", "Matrix"):
        return _matrix(args[0] if len(args) == 1 and isinstance(args[0], list) else args)
    if any(isinstance(a, list) for a in args):
        raise CasError("unsupported", "%s does not take a list" % fn)
    if fn == "deg":
        return args[0] * sp.pi / 180
    if fn == "rad":
        return args[0]
    if fn in TRIG_DEG:
        a = args[0]
        if ctx.angle == "deg" and _numeric(a):
            ctx.warn("angle mode is degrees: numeric arguments of sin/cos/tan were read as degrees")
            a = a * sp.pi / 180
        return FN[fn](a)
    if fn == "log":
        if len(args) == 1:
            return sp.log(args[0], 10)
        return sp.log(args[0], args[1])
    if fn == "log2":
        return sp.log(args[0], 2)
    if fn == "log10":
        return sp.log(args[0], 10)
    if fn == "cbrt":
        return sp.cbrt(args[0])
    if fn == "root":
        return sp.root(args[0], args[1])
    if fn == "round":
        return sp.floor(args[0] + sp.Rational(1, 2))
    if fn == "min":
        return sp.Min(*args)
    if fn == "max":
        return sp.Max(*args)
    if fn == "factorial":
        a = args[0]
        if a.is_Integer and (a < 0 or a > LIMITS.max_factorial):
            raise CasError("resource_limit" if a > 0 else "domain", "factorial needs 0 <= n <= %d" % LIMITS.max_factorial)
        if not _numeric(a):
            return sp.factorial(a)
        if not a.is_Integer:
            return sp.gamma(a + 1)
        return sp.factorial(a)
    if fn in FN:
        return FN[fn](*args)
    raise CasError("unsupported", "unknown function %s" % str(fn)[:30])
