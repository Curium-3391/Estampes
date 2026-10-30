"""SymPy -> estampes.math-ast/1 plus plain and LaTeX text. Output is an
allowlist: nodes SymPy produces that are not listed become an opaque,
read-only node with text only. srepr/eval are never used."""
import re

import sympy as sp

from . import AST_SCHEMA

NAMES = {
    sp.sin: "sin", sp.cos: "cos", sp.tan: "tan", sp.sec: "sec", sp.csc: "csc", sp.cot: "cot",
    sp.asin: "asin", sp.acos: "acos", sp.atan: "atan", sp.acot: "acot", sp.atan2: "atan2",
    sp.sinh: "sinh", sp.cosh: "cosh", sp.tanh: "tanh", sp.asinh: "asinh", sp.acosh: "acosh", sp.atanh: "atanh",
    sp.exp: "exp", sp.log: "ln", sp.Abs: "abs", sp.sign: "sign", sp.floor: "floor", sp.ceiling: "ceil",
    sp.gamma: "gamma", sp.re: "re", sp.im: "im", sp.conjugate: "conjugate", sp.arg: "arg",
    sp.factorial: "factorial", sp.binomial: "binomial", sp.Min: "min", sp.Max: "max", sp.Mod: "mod",
}
RELS = {sp.Eq: "=", sp.Ne: "!=", sp.Lt: "<", sp.Le: "<=", sp.Gt: ">", sp.Ge: ">="}
MAX_AST_NODES = 4000


def plain(e):
    if type(e) in RELS:
        return plain(e.lhs) + " " + RELS[type(e)] + " " + plain(e.rhs)
    if isinstance(e, (list, tuple)):
        return "[" + ", ".join(plain(x) for x in e) + "]"
    s = sp.sstr(e)
    s = s.replace("**", "^").replace("Abs(", "abs(").replace("log(", "ln(")
    return re.sub(r"\bE\b", "e", s)


def latex(e):
    if isinstance(e, (list, tuple)):
        return "\\left[" + ", ".join(latex(x) for x in e) + "\\right]"
    return sp.latex(e)


def to_ast(e, _count=None):
    c = _count if _count is not None else [0]
    c[0] += 1
    if c[0] > MAX_AST_NODES:
        return {"node": "opaque", "plain": plain(e)[:200]}
    r = lambda x: to_ast(x, c)
    if isinstance(e, (list, tuple)):
        return {"node": "list", "items": [r(x) for x in e]}
    if isinstance(e, sp.MatrixBase):
        return {"node": "matrix", "rows": [[r(e[i, j]) for j in range(e.cols)] for i in range(e.rows)]}
    if isinstance(e, sp.FiniteSet):
        return {"node": "list", "items": [r(x) for x in sorted(e.args, key=sp.default_sort_key)]}
    if e is sp.S.true or e is sp.S.false:
        return {"node": "opaque", "plain": str(bool(e)).lower()}
    if isinstance(e, sp.Integer):
        return {"node": "integer", "value": str(int(e))}
    if isinstance(e, sp.Rational):
        return {"node": "rational", "num": str(e.p), "den": str(e.q)}
    if isinstance(e, sp.Float):
        return {"node": "float", "value": sp.sstr(e)}
    if e is sp.pi:
        return {"node": "constant", "name": "pi"}
    if e is sp.E:
        return {"node": "constant", "name": "e"}
    if e is sp.I:
        return {"node": "constant", "name": "I"}
    if e is sp.oo:
        return {"node": "constant", "name": "oo"}
    if e is sp.nan:
        return {"node": "constant", "name": "nan"}
    if isinstance(e, sp.Symbol):
        return {"node": "symbol", "name": e.name}
    if isinstance(e, sp.Add):
        return {"node": "add", "args": [r(a) for a in e.as_ordered_terms()]}
    if isinstance(e, sp.Mul):
        return {"node": "mul", "args": [r(a) for a in e.as_ordered_factors()]}
    if isinstance(e, sp.Pow):
        if e.exp == sp.Rational(1, 2):
            return {"node": "call", "fn": "sqrt", "args": [r(e.base)]}
        return {"node": "pow", "left": r(e.base), "right": r(e.exp)}
    if type(e) in RELS:
        return {"node": "rel", "op": RELS[type(e)], "left": r(e.lhs), "right": r(e.rhs)}
    name = NAMES.get(type(e))
    if name and not e.is_Atom:
        return {"node": "call", "fn": name, "args": [r(a) for a in e.args]}
    return {"node": "opaque", "plain": plain(e)[:400]}


def text(e):
    return {"ast": dict(to_ast(e), schema=AST_SCHEMA), "plain": plain(e), "latex": latex(e)}
