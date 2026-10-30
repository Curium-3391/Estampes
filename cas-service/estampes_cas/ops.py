"""CAS operations. One function per operation; each takes the validated
request and returns a result dict. Everything user-controlled arrives as an
AST (from parser.parse) and is mapped by interp.to_sympy."""
import sympy as sp

from . import RESULT_PROTOCOL
from .interp import ASSUMPTIONS, Context, to_sympy
from .limits import LIMITS, CasError
from .latex_in import latex_to_text
from .parser import parse
from .serialize import plain, text

VERSION = sp.__version__
OPERATIONS = (
    "evaluate", "simplify", "expand", "factor", "collect", "cancel", "apart", "together", "trigsimp",
    "differentiate", "integrate", "limit", "series", "summation", "product",
    "solve", "solve_system", "nsolve", "substitute", "matrix",
)
PARTIAL = (sp.Integral, sp.Limit, sp.Sum, sp.Product, sp.Derivative, sp.Subs, sp.Order)


def as_ast(v):
    if isinstance(v, str):
        return parse(v)
    if isinstance(v, dict):
        return v
    raise CasError("syntax", "expected text or an AST")


def expr(v, ctx):
    return to_sympy(as_ast(v), ctx)


def one_variable(e, ctx, name=None):
    if name:
        if name in ctx.defs:
            raise CasError("syntax", "%s is a defined name, not a variable" % name)
        return ctx.symbol(name)
    free = sorted(e.free_symbols, key=lambda s: s.name) if hasattr(e, "free_symbols") else []
    if len(free) == 1:
        return free[0]
    if not free:
        raise CasError("domain", "the expression has no variable")
    raise CasError("syntax", "name the variable (%s)" % ", ".join(s.name for s in free))


def has_bad(e):
    return e.has(sp.nan, sp.zoo) if hasattr(e, "has") else False


def classify(e, approximate=False):
    if isinstance(e, (list, tuple)):
        st = [classify(x) for x in e]
        for pick in ("undefined", "partial", "conditional", "complex", "approximate"):
            if pick in st:
                return pick
        return "exact"
    if isinstance(e, sp.MatrixBase):
        return classify(list(e), approximate)
    if has_bad(e):
        return "undefined"
    if e.has(*PARTIAL) or e.has(sp.ConditionSet):
        return "partial"
    if e.has(sp.Piecewise) or isinstance(e, (sp.Union, sp.Intersection, sp.ImageSet, sp.Complement)):
        return "conditional"
    if e.has(sp.Float) or approximate:
        return "approximate"
    if e.has(sp.I) or e.has(sp.re, sp.im):
        return "complex"
    return "exact"


def numeric(e, digits):
    try:
        if isinstance(e, sp.MatrixBase):
            return {"plain": plain(e.evalf(digits)), "digits": digits}
        if isinstance(e, (list, tuple)):
            return {"plain": plain([sp.N(x, digits) for x in e]), "digits": digits}
        if e.free_symbols or not hasattr(e, "evalf"):
            return None
        v = sp.N(e, digits)
        if v.has(sp.nan, sp.zoo):
            return None
        return {"plain": sp.sstr(v), "latex": sp.latex(v), "digits": digits}
    except Exception:
        return None


def finish(op, e, ctx, digits, extra=None):
    st = classify(e)
    out = {"operation": op, "status": st, "exact": text(e), "warnings": list(ctx.warnings)}
    if st in ("exact", "complex", "approximate") or (st == "conditional" and not getattr(e, "free_symbols", None)):
        a = numeric(e, digits)
        if a and a["plain"] != out["exact"]["plain"]:
            out["approx"] = a
    if st == "partial":
        out["warnings"].append("SymPy returned an unevaluated expression: no closed form was found")
    if st == "undefined":
        out["warnings"].append("the result is undefined (NaN or complex infinity)")
    out.update(extra or {})
    return out


def run_op(op, p, ctx, digits):
    inp = p.get("input") or {}
    params = p.get("params") or {}
    get = lambda k, d=None: params.get(k, inp.get(k, d))
    if op == "solve_system":
        return solve_system(inp, params, ctx, digits)
    src = inp.get("ast") or inp.get("text")
    if src is None and inp.get("latex") is not None:
        src = latex_to_text(inp["latex"])
    if src is None:
        raise CasError("syntax", "no input")
    e = expr(src, ctx)
    if op == "evaluate":
        if isinstance(e, sp.Basic) and not isinstance(e, sp.Rel):
            e = e.doit()
        return finish(op, e, ctx, digits)
    if op in ("simplify", "expand", "factor", "cancel", "together", "trigsimp"):
        fn = {"simplify": sp.simplify, "expand": sp.expand, "factor": sp.factor, "cancel": sp.cancel,
              "together": sp.together, "trigsimp": sp.trigsimp}[op]
        return finish(op, fn(e), ctx, digits)
    if op in ("collect", "apart"):
        v = one_variable(e, ctx, get("variable"))
        return finish(op, (sp.collect if op == "collect" else sp.apart)(sp.expand(e) if op == "collect" else e, v), ctx, digits)
    if op == "differentiate":
        v = one_variable(e, ctx, get("variable"))
        order = int(get("order", 1))
        if not 1 <= order <= 10:
            raise CasError("domain", "order must be between 1 and 10")
        return finish(op, sp.diff(e, v, order), ctx, digits, {"variable": v.name, "order": order})
    if op == "integrate":
        v = one_variable(e, ctx, get("variable"))
        lo, hi = get("lower"), get("upper")
        if (lo is None) != (hi is None):
            raise CasError("syntax", "give both lower and upper, or neither")
        if lo is None:
            r = sp.integrate(e, v)
            extra = {"variable": v.name, "plusC": True}
            res = finish(op, r, ctx, digits, extra)
            if res["status"] != "partial":
                res["display"] = {"plain": plain(r) + " + C", "latex": sp.latex(r) + " + C"}
            return res
        r = sp.integrate(e, (v, expr(lo, ctx), expr(hi, ctx)))
        return finish(op, r, ctx, digits, {"variable": v.name})
    if op == "limit":
        v = one_variable(e, ctx, get("variable"))
        d = get("direction", "+-")
        if d not in ("+", "-", "+-"):
            raise CasError("syntax", "direction must be +, - or +-")
        return finish(op, sp.limit(e, v, expr(get("point", "0"), ctx), d), ctx, digits, {"variable": v.name})
    if op == "series":
        v = one_variable(e, ctx, get("variable"))
        n = int(get("n", 6))
        if not 1 <= n <= 30:
            raise CasError("domain", "n must be between 1 and 30")
        s = sp.series(e, v, expr(get("point", "0"), ctx), n)
        r = s.removeO()
        res = finish(op, r, ctx, digits, {"variable": v.name, "order": n})
        res["display"] = {"plain": plain(r) + " + O(" + plain(v) + "^" + str(n) + ")", "latex": sp.latex(s)}
        return res
    if op in ("summation", "product"):
        v = one_variable(e, ctx, get("variable"))
        lo, hi = expr(get("lower", "1"), ctx), expr(get("upper", "oo"), ctx)
        if hi.is_Integer and lo.is_Integer and hi - lo > 100000:
            raise CasError("resource_limit", "that range is too long")
        r = (sp.summation if op == "summation" else sp.product)(e, (v, lo, hi))
        return finish(op, r, ctx, digits, {"variable": v.name})
    if op == "substitute":
        subs = get("subs") or {}
        if not isinstance(subs, dict) or not subs or len(subs) > 8:
            raise CasError("syntax", "subs: give 1-8 name: value pairs")
        r = e.subs({ctx.symbol(k): expr(v, ctx) for k, v in subs.items()}, simultaneous=True)
        return finish(op, r, ctx, digits)
    if op == "solve":
        return solve(e, get, ctx, digits)
    if op == "nsolve":
        v = one_variable(e, ctx, get("variable"))
        if get("guess") is None:
            raise CasError("syntax", "nsolve needs a starting guess")
        eq = e.lhs - e.rhs if isinstance(e, sp.Rel) else e
        try:
            r = sp.nsolve(eq, v, sp.N(expr(get("guess"), ctx), digits), prec=digits)
        except (ValueError, ZeroDivisionError, TypeError) as ex:
            raise CasError("domain", "nsolve found no solution near that guess: %s" % str(ex)[:120])
        return finish(op, r, ctx, digits, {"variable": v.name, "approximate": True})
    if op == "matrix":
        return matrix_op(e, get, ctx, digits, expr)
    raise CasError("unsupported", "unknown operation %s" % str(op)[:30])


def solve(e, get, ctx, digits):
    v = one_variable(e.lhs - e.rhs if isinstance(e, sp.Rel) else e, ctx, get("variable"))
    domain = get("domain", "complex")
    if isinstance(e, sp.Rel) and not isinstance(e, sp.Eq):
        if domain != "real":
            ctx.warn("inequalities are solved over the reals")
        dom = sp.S.Reals
        r = sp.solveset(e, v, dom)
        return finish("solve", r, ctx, digits, {"variable": v.name, "domain": "real"})
    eq = sp.Eq(e.lhs, e.rhs) if isinstance(e, sp.Eq) else sp.Eq(e, 0)
    dom = sp.S.Reals if domain == "real" else sp.S.Complexes
    r = sp.solveset(eq, v, dom)
    if isinstance(r, sp.FiniteSet):
        items = sorted(r.args, key=sp.default_sort_key)
        res = finish("solve", items, ctx, digits, {"variable": v.name, "domain": domain})
        res["items"] = [text(x) for x in items]
        res["exact"]["plain"] = ", ".join("%s = %s" % (v.name, plain(x)) for x in items) or "no solutions"
        return res
    res = finish("solve", r, ctx, digits, {"variable": v.name, "domain": domain})
    if res["status"] == "exact":
        res["status"] = "conditional"
    res["warnings"].append("the solution set is not a finite list of values")
    return res


def solve_system(inp, params, ctx, digits):
    eqs = inp.get("equations") or []
    if not isinstance(eqs, list) or not 1 <= len(eqs) <= 8:
        raise CasError("syntax", "give 1-8 equations")
    es = []
    for q in eqs:
        x = expr(q, ctx)
        es.append(x if isinstance(x, sp.Eq) else sp.Eq(x, 0))
    names = params.get("variables") or inp.get("variables")
    if names:
        vs = [ctx.symbol(n) for n in names[:8]]
    else:
        vs = sorted(set().union(*[q.free_symbols for q in es]), key=lambda s: s.name)
    if not vs:
        raise CasError("domain", "no variables to solve for")
    if all(sp.Poly(q.lhs - q.rhs, *vs).total_degree() <= 1 for q in es):
        sol = sp.linsolve(es, *vs)
        sols = [dict(zip(vs, t)) for t in sol.args] if sol != sp.S.EmptySet else []
    else:
        sols = sp.solve(es, vs, dict=True)
    items = []
    for s in sols[:32]:
        items.append([sp.Eq(k, s[k]) for k in vs if k in s])
    res = finish("solve_system", items, ctx, digits)
    res["items"] = [{"plain": ", ".join(plain(q) for q in it).replace("==", "="), "ast": [text(q)["ast"] for q in it]} for it in items]
    res["exact"]["plain"] = "; ".join(i["plain"] for i in res["items"]) or "no solutions"
    if res["status"] == "exact" and not items:
        res["warnings"].append("the system has no solution")
    return res


def matrix_op(e, get, ctx, digits, expr):
    if isinstance(e, list):
        from .interp import _matrix
        e = _matrix(e)
    if not isinstance(e, sp.MatrixBase):
        raise CasError("syntax", "the input is not a matrix, write [[1,2],[3,4]]")
    mode = get("mode", "determinant")
    if mode in ("add", "multiply"):
        other = expr(get("other"), ctx)
        if isinstance(other, list):
            from .interp import _matrix
            other = _matrix(other)
        r = e + other if mode == "add" else e * other
    elif mode == "determinant":
        r = e.det()
    elif mode == "inverse":
        try:
            r = e.inv()
        except (sp.matrices.exceptions.NonInvertibleMatrixError, ValueError) as ex:
            raise CasError("domain", "the matrix is not invertible")
    elif mode == "transpose":
        r = e.T
    elif mode == "rank":
        r = sp.Integer(e.rank())
    elif mode == "rref":
        r = e.rref()[0]
    elif mode == "trace":
        r = e.trace()
    elif mode == "eigenvalues":
        ev = e.eigenvals()
        r = [k for k, m in sorted(ev.items(), key=lambda kv: sp.default_sort_key(kv[0])) for _ in range(m)]
    else:
        raise CasError("unsupported", "unknown matrix mode %s" % str(mode)[:30])
    return finish("matrix", r, ctx, digits, {"mode": mode})


def compute(req):
    """req: {operation, input, params, env, angle, precision}. Returns the result dict."""
    op = req.get("operation")
    if op not in OPERATIONS:
        raise CasError("unsupported", "unknown operation %s" % str(op)[:30])
    digits = req.get("precision", 15)
    if not isinstance(digits, int) or not 5 <= digits <= LIMITS.max_precision:
        raise CasError("domain", "precision must be 5-%d digits" % LIMITS.max_precision)
    ctx = Context(req.get("env"), req.get("angle", "rad"))
    try:
        out = run_op(op, req, ctx, digits)
    except CasError:
        raise
    except RecursionError:
        raise CasError("resource_limit", "the calculation is too deep")
    except MemoryError:
        raise CasError("resource_limit", "the calculation needs too much memory")
    except (sp.PolynomialError, sp.SympifyError, NotImplementedError) as ex:
        raise CasError("unsupported", "SymPy cannot do this: %s" % str(ex)[:160])
    except (ZeroDivisionError, ValueError, TypeError, ArithmeticError) as ex:
        raise CasError("domain", str(ex)[:200] or "domain error")
    out["engine"] = {"name": "SymPy", "version": VERSION}
    out["protocol"] = RESULT_PROTOCOL
    out["angle"] = ctx.angle
    out["precision"] = digits
    return out
