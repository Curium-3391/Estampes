"""LaTeX (a bounded math subset) -> the closed expression text that
parser.parse understands. It is a translator, not an interpreter: unknown
commands are errors, and the result still goes through the strict parser."""
import re

from .limits import LIMITS, CasError

SAME = {"sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan", "exp", "ln", "log", "min", "max", "gcd", "arg", "deg"}
SYM = {"pi": "pi", "infty": "oo", "cdot": "*", "times": "*", "div": "/", "le": "<=", "leq": "<=", "ge": ">=", "geq": ">=", "ne": "!=", "neq": "!=",
       "alpha": "alpha", "beta": "beta", "gamma": "gamma_", "delta": "delta", "epsilon": "epsilon", "theta": "theta", "lambda": "lam", "mu": "mu",
       "sigma": "sigma", "phi": "phi", "omega": "omega", "rho": "rho", "tau": "tau", "varphi": "phi", "ell": "l"}
DROP = {"left", "right", "displaystyle", "textstyle", "big", "Big", "bigg", "Bigg", ",", ";", "!", " ", ":", "quad", "qquad"}
TOKEN = re.compile(r"\\([A-Za-z]+|.)|([{}^_()\[\]|!+\-*/=<>,.])|(\d+\.?\d*|\.\d+)|([A-Za-z])|(\s+)")


def tokens(src):
    if len(src) > LIMITS.max_expr_chars:
        raise CasError("resource_limit", "expression is too long")
    out, i = [], 0
    while i < len(src):
        m = TOKEN.match(src, i)
        if not m:
            raise CasError("syntax", "LaTeX: unexpected character %r at %d" % (src[i], i + 1))
        i = m.end()
        if m.group(5):
            continue
        out.append(("cmd", m.group(1)) if m.group(1) else ("ch", m.group(2) or m.group(3) or m.group(4)))
    return out


class Tr:
    def __init__(self, toks):
        self.t, self.i, self.depth = toks, 0, 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def group(self):
        """A {...} group (or a single token) as translated text."""
        tok = self.peek()
        if tok is None:
            raise CasError("syntax", "LaTeX: a group is missing")
        if tok == ("ch", "{"):
            self.i += 1
            self.depth += 1
            if self.depth > 40:
                raise CasError("resource_limit", "LaTeX nested too deeply")
            s = self.seq(until="}")
            self.depth -= 1
            return s
        return self.one()

    def seq(self, until=None):
        out = []
        while True:
            tok = self.peek()
            if tok is None:
                if until:
                    raise CasError("syntax", "LaTeX: missing }")
                return "".join(out)
            if until and tok == ("ch", until):
                self.i += 1
                return "".join(out)
            out.append(self.one())

    def one(self):
        kind, v = self.t[self.i]
        self.i += 1
        if kind == "ch":
            if v == "{":
                self.i -= 1
                return "(" + self.group() + ")"
            if v == "}":
                raise CasError("syntax", "LaTeX: unmatched }")
            if v == "^":
                return "^" + self.script()
            if v == "_":
                s = self.script()
                return "_" + re.sub(r"[^A-Za-z0-9]", "", s)
            return v if v not in "<>=" else v
        if v in DROP:
            return ""
        if v == "frac" or v == "dfrac" or v == "tfrac":
            a = self.group(); b = self.group()
            return "((" + a + ")/(" + b + "))"
        if v == "sqrt":
            if self.peek() == ("ch", "["):
                self.i += 1
                n = self.seq(until="]")
                return "root(" + self.group() + "," + n + ")"
            return "sqrt(" + self.group() + ")"
        if v in ("lvert", "rvert", "vert"):
            return "|"
        if v in ("lbrace", "rbrace"):
            raise CasError("unsupported", "LaTeX: sets are not supported")
        if v in ("mathrm", "operatorname", "text", "mathit"):
            g = self.group()
            return g
        if v in SAME:
            return " " + v
        if v in SYM:
            return " " + SYM[v] + " "
        raise CasError("unsupported", "LaTeX command \\%s is not supported" % v[:20])

    def script(self):
        tok = self.peek()
        if tok == ("ch", "{"):
            return "(" + self.group() + ")"
        return "(" + self.one() + ")"


def latex_to_text(src):
    if not isinstance(src, str) or not src.strip():
        raise CasError("syntax", "the LaTeX is empty")
    s = src.strip().strip("$")
    s = re.sub(r"\\(?:begin|end)\{[^}]*\}", "", s)
    t = Tr(tokens(s))
    out = t.seq()
    return out.replace("^(", "^(")
