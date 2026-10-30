"""Closed expression language -> estampes.math-ast/1 (dict nodes).

Only the tokens below exist. No attribute access, subscripts, strings,
comprehensions, lambdas or statements: they are lexical errors, so nothing
Python-shaped can ever be evaluated. The parser never calls eval/sympify.

  ^ or **  power (right-assoc)    n!  factorial        |x|  absolute value
  2x, 2(x+1), (x+1)(x-1), 2pi   implicit multiplication
  x^2=4, a<=b, a!=b             relations   [1,2,3] / [[1,2],[3,4]]  lists
"""
import re
from fractions import Fraction

from . import AST_SCHEMA
from .limits import LIMITS, CasError

CONSTANTS = {"pi": "pi", "π": "pi", "e": "e", "E": "e", "I": "I", "oo": "oo", "inf": "oo", "infinity": "oo", "nan": "nan"}
# Name -> arity (None: any count within 1..8). Names outside this table are rejected.
FUNCTIONS = {
    "sin": 1, "cos": 1, "tan": 1, "sec": 1, "csc": 1, "cot": 1,
    "asin": 1, "acos": 1, "atan": 1, "atan2": 2, "acot": 1,
    "arcsin": 1, "arccos": 1, "arctan": 1,
    "sinh": 1, "cosh": 1, "tanh": 1, "asinh": 1, "acosh": 1, "atanh": 1,
    "exp": 1, "ln": 1, "log": None, "log2": 1, "log10": 1, "sqrt": 1, "cbrt": 1, "root": 2,
    "abs": 1, "sign": 1, "floor": 1, "ceil": 1, "round": 1, "factorial": 1,
    "min": None, "max": None, "gamma": 1, "re": 1, "im": 1, "conjugate": 1, "arg": 1,
    "deg": 1, "rad": 1, "binomial": 2, "gcd": 2, "lcm": 2, "mod": 2,
    "Matrix": None, "matrix": None,
}
# Functions that exist as operations, not as expressions: the operation
# selector does these (diff, integrate ...), so they are not call targets.
IDENT = re.compile(r"[A-Za-z_Ͱ-Ͽ][A-Za-z0-9_Ͱ-Ͽ]*")
NUM = re.compile(r"(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")
REL = ("<=", ">=", "!=", "==", "=", "<", ">", "≤", "≥", "≠")
OPS = set("+-*/^(),[]|!") | {"×", "·", "÷", "−"}
MAX_IDENT = 24
# Words that only make sense as code. They are never symbols, so input that
# looks like a Python statement fails loudly instead of becoming a product.
RESERVED = {"for", "in", "if", "else", "elif", "lambda", "import", "from", "def", "class", "del", "exec", "eval", "global", "nonlocal",
            "and", "or", "not", "is", "while", "try", "with", "yield", "return", "pass", "raise", "assert", "None", "True", "False", "print"}


def lex(src):
    if len(src) > LIMITS.max_expr_chars:
        raise CasError("resource_limit", "expression is longer than %d characters" % LIMITS.max_expr_chars)
    toks, i = [], 0
    while i < len(src):
        c = src[i]
        if c.isspace():
            i += 1
            continue
        m = NUM.match(src, i)
        if m and (c.isdigit() or c == "."):
            toks.append(("num", m.group(0), i)); i = m.end(); continue
        m = IDENT.match(src, i) if (c.isalpha() or c == "_" or "Ͱ" <= c <= "Ͽ") else None
        if m:
            name = m.group(0)
            if len(name) > MAX_IDENT or name.startswith("_") or name.endswith("_") or "__" in name:
                raise CasError("syntax", "name %r is not allowed (at character %d)" % (name[:30], i + 1))
            if name in RESERVED:
                raise CasError("syntax", "%r is not allowed in a math expression (at character %d)" % (name, i + 1))
            toks.append(("id", name, i)); i = m.end(); continue
        if src.startswith("**", i):
            toks.append(("op", "^", i)); i += 2; continue
        rel = next((r for r in REL if src.startswith(r, i)), None)
        if rel:
            toks.append(("rel", {"≤": "<=", "≥": ">=", "≠": "!=", "==": "="}.get(rel, rel), i)); i += len(rel); continue
        if c in OPS:
            toks.append(("op", {"×": "*", "·": "*", "÷": "/", "−": "-"}.get(c, c), i)); i += 1; continue
        raise CasError("syntax", "unexpected character %r (at character %d)" % (c, i + 1))
    return toks


def integer(v):
    if len(str(v).lstrip("-")) > LIMITS.max_int_digits:
        raise CasError("resource_limit", "integer has more than %d digits" % LIMITS.max_int_digits)
    return {"node": "integer", "value": str(v)}


def number_node(text):
    """Decimals are exact rationals: 0.1 is 1/10, never a binary float."""
    f = Fraction(text)
    if f.denominator == 1:
        return integer(f.numerator)
    if len(str(f.numerator)) > LIMITS.max_int_digits or len(str(f.denominator)) > LIMITS.max_int_digits:
        raise CasError("resource_limit", "number has too many digits")
    return {"node": "rational", "num": str(f.numerator), "den": str(f.denominator)}


class Parser:
    def __init__(self, src):
        self.toks = lex(src)
        self.pos = 0
        self.nodes = 0
        self.depth = 0
        self.bars = 0

    def peek(self):
        return self.toks[self.pos] if self.pos < len(self.toks) else None

    def is_op(self, v):
        t = self.peek()
        return t is not None and t[0] == "op" and t[1] == v

    def at(self):
        t = self.peek()
        return (t[2] + 1) if t else (self.toks[-1][2] + 2 if self.toks else 1)

    def node(self, n):
        self.nodes += 1
        if self.nodes > LIMITS.max_nodes:
            raise CasError("resource_limit", "expression is too complex")
        return n

    def enter(self):
        self.depth += 1
        if self.depth > LIMITS.max_depth:
            raise CasError("resource_limit", "expression is nested deeper than %d levels" % LIMITS.max_depth)

    def expect(self, v):
        if not self.is_op(v):
            raise CasError("syntax", "expected %r at character %d" % (v, self.at()))
        self.pos += 1

    def statement(self):
        left = self.expr()
        t = self.peek()
        if t and t[0] == "rel":
            self.pos += 1
            right = self.expr()
            left = self.node({"node": "rel", "op": t[1], "left": left, "right": right})
            if self.peek() and self.peek()[0] == "rel":
                raise CasError("unsupported", "chained relations are not supported")
        if self.peek() is not None:
            raise CasError("syntax", "unexpected %r at character %d" % (self.peek()[1], self.at()))
        return left

    def expr(self):
        self.enter()
        left = self.term()
        args = [left]
        while self.is_op("+") or self.is_op("-"):
            op = self.toks[self.pos][1]; self.pos += 1
            r = self.term()
            args.append(r if op == "+" else self.node({"node": "neg", "arg": r}))
        self.depth -= 1
        return args[0] if len(args) == 1 else self.node({"node": "add", "args": args})

    def starts_factor(self):
        t = self.peek()
        if not t:
            return False
        if t[0] in ("num", "id"):
            return True
        return t[0] == "op" and (t[1] == "(" or (t[1] == "|" and self.bars == 0))

    def term(self):
        first = self.unary()
        items = [("*", first)]
        while True:
            if self.is_op("*") or self.is_op("/"):
                op = self.toks[self.pos][1]; self.pos += 1
                items.append((op, self.unary()))
            elif self.starts_factor():
                items.append(("*", self.unary()))
            else:
                break
        if len(items) == 1:
            return first
        # a/b*c is (a/b)*c: fold left, keeping division explicit.
        acc = items[0][1]
        for op, v in items[1:]:
            acc = self.node({"node": "div", "left": acc, "right": v}) if op == "/" else self.node({"node": "mul", "args": acc["args"] + [v] if acc.get("node") == "mul" and acc.get("flat") else [acc, v], "flat": True})
        return self._unflag(acc)

    def _unflag(self, n):
        if isinstance(n, dict):
            n.pop("flat", None)
            for v in n.values():
                if isinstance(v, dict):
                    self._unflag(v)
                elif isinstance(v, list):
                    for x in v:
                        self._unflag(x)
        return n

    def unary(self):
        if self.is_op("-"):
            self.pos += 1; self.enter()
            r = self.unary(); self.depth -= 1
            return self.node({"node": "neg", "arg": r})
        if self.is_op("+"):
            self.pos += 1
            return self.unary()
        return self.power()

    def power(self):
        base = self.postfix()
        if self.is_op("^"):
            self.pos += 1; self.enter()
            exp = self.unary(); self.depth -= 1
            return self.node({"node": "pow", "left": base, "right": exp})
        return base

    def postfix(self):
        a = self.atom()
        while self.is_op("!"):
            self.pos += 1
            a = self.node({"node": "call", "fn": "factorial", "args": [a]})
        return a

    def atom(self):
        t = self.peek()
        if t is None:
            raise CasError("syntax", "the expression ends too early")
        kind, val, at = t
        if kind == "num":
            self.pos += 1
            return self.node(number_node(val))
        if kind == "id":
            self.pos += 1
            if self.is_op("(") and (val in FUNCTIONS or val not in CONSTANTS):
                self.pos += 1
                args = self.args(")")
                if val in FUNCTIONS:
                    want = FUNCTIONS[val]
                    if (want is not None and len(args) != want) or not (1 <= len(args) <= 8 and (want is not None or True)):
                        raise CasError("syntax", "%s takes %s argument(s)" % (val, want if want is not None else "1-8"))
                    return self.node({"node": "call", "fn": "matrix" if val == "Matrix" else val, "args": args})
                # A user-defined function f(x): resolved against the notebook's definitions.
                return self.node({"node": "call", "fn": val, "args": args, "user": True})
            if val in CONSTANTS:
                return self.node({"node": "constant", "name": CONSTANTS[val]})
            return self.node({"node": "symbol", "name": val})
        if kind == "op":
            if val == "(":
                self.pos += 1; self.enter()
                e = self.expr(); self.depth -= 1
                self.expect(")")
                return e
            if val == "[":
                self.pos += 1; self.enter()
                items = self.args("]"); self.depth -= 1
                return self.node({"node": "list", "items": items})
            if val == "|":
                self.pos += 1; self.bars += 1; self.enter()
                e = self.expr(); self.depth -= 1
                self.bars -= 1
                self.expect("|")
                return self.node({"node": "call", "fn": "abs", "args": [e]})
        raise CasError("syntax", "unexpected %r at character %d" % (val, at + 1))

    def args(self, close):
        out = []
        if self.is_op(close):
            self.pos += 1
            return out
        while True:
            out.append(self.expr())
            if self.is_op(","):
                self.pos += 1
                if len(out) >= 64:
                    raise CasError("resource_limit", "too many items")
                continue
            self.expect(close)
            return out


def parse(src):
    """Text -> {schema, node...}. Raises CasError(syntax|resource_limit|unsupported)."""
    if not isinstance(src, str) or not src.strip():
        raise CasError("syntax", "the expression is empty")
    ast = Parser(src).statement()
    ast = _fix_mul(ast)
    ast["schema"] = AST_SCHEMA
    return ast


def _fix_mul(n):
    """Flatten the left-folded mul chains produced by implicit multiplication."""
    if isinstance(n, dict):
        for k, v in list(n.items()):
            n[k] = _fix_mul(v)
        if n.get("node") == "mul":
            flat = []
            for a in n["args"]:
                if isinstance(a, dict) and a.get("node") == "mul":
                    flat.extend(a["args"])
                else:
                    flat.append(a)
            n["args"] = flat
    elif isinstance(n, list):
        return [_fix_mul(x) for x in n]
    return n
