import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from estampes_cas.ops import compute
from estampes_cas.parser import parse
from estampes_cas.limits import CasError


def run(op, text=None, **kw):
    req = {"operation": op, "input": kw.pop("input", {"text": text}), **kw}
    return compute(req)


def plain(op, text, **kw):
    return run(op, text, **kw)["exact"]["plain"]


class Math(unittest.TestCase):
    def test_exact(self):
        self.assertEqual(plain("evaluate", "1/3+1/6"), "1/2")
        self.assertEqual(plain("evaluate", "sqrt(8)"), "2*sqrt(2)")
        self.assertEqual(plain("simplify", "sin(x)^2+cos(x)^2"), "1")
        self.assertEqual(plain("evaluate", "I^2"), "-1")
        self.assertEqual(plain("evaluate", "0.1+0.2"), "3/10")

    def test_calculus(self):
        self.assertEqual(plain("differentiate", "sin(x^2)", params={"variable": "x"}), "2*x*cos(x^2)")
        r = run("integrate", "2*x")
        self.assertEqual(r["display"]["plain"], "x^2 + C")
        self.assertEqual(plain("integrate", "x^2", params={"variable": "x", "lower": "0", "upper": "1"}), "1/3")
        self.assertEqual(plain("limit", "sin(x)/x"), "1")
        self.assertIn("x^3/6", plain("series", "sin(x)"))
        self.assertEqual(plain("summation", "k", params={"variable": "k", "lower": "1", "upper": "10"}), "55")

    def test_algebra(self):
        self.assertEqual(plain("factor", "x^2-4"), "(x - 2)*(x + 2)")
        self.assertEqual(plain("solve", "x^2-4=0"), "x = -2, x = 2")
        r = run("solve_system", input={"equations": ["x+y=3", "x-y=1"]})
        self.assertEqual(r["exact"]["plain"], "x = 2, y = 1")
        self.assertEqual(plain("matrix", "[[1,2],[3,4]]", params={"mode": "determinant"}), "-2")
        self.assertEqual(plain("expand", "(x+1)^2"), "x^2 + 2*x + 1")
        self.assertEqual(plain("substitute", "x^2+y", params={"subs": {"x": "3"}}), "y + 9")
        self.assertAlmostEqual(float(run("nsolve", "cos(x)=x", params={"guess": "1"})["exact"]["plain"]), 0.7390851332, 6)

    def test_angles_and_precision(self):
        r = run("evaluate", "sin(30)", angle="deg")
        self.assertEqual(r["exact"]["plain"], "1/2")
        self.assertTrue(r["warnings"])
        self.assertEqual(plain("evaluate", "sin(deg(30))"), "1/2")
        self.assertEqual(plain("evaluate", "sin(x)", angle="deg"), "sin(x)")
        self.assertEqual(len(run("evaluate", "pi", precision=50)["approx"]["plain"]), 51)

    def test_status_is_honest(self):
        self.assertEqual(run("solve", "sin(x)=0", params={"domain": "real"})["status"], "conditional")
        self.assertEqual(run("integrate", "x^x")["status"], "partial")
        self.assertEqual(run("evaluate", "sqrt(-4)")["status"], "complex")

    def test_notebook_environment(self):
        env = {"definitions": {"f": {"params": ["x"], "body": parse("x^2+a")}, "a": {"params": [], "body": parse("3")}}}
        self.assertEqual(plain("evaluate", "f(2)", env=env), "7")
        pos = {"assumptions": {"x": ["positive"]}}
        self.assertEqual(plain("simplify", "sqrt(x^2)", env=pos), "x")

    def test_latex_round_trip(self):
        r = run("differentiate", input={"latex": r"\sin\left(x^{2}\right)"}, params={"variable": "x"})
        back = compute({"operation": "evaluate", "input": {"latex": r["exact"]["latex"]}})
        self.assertEqual(back["exact"]["plain"], r["exact"]["plain"])
        self.assertEqual(plain("evaluate", None, input={"latex": r"\frac{1}{3}+\frac{1}{6}"}), "1/2")

    def test_ast_round_trip(self):
        r = run("differentiate", "sin(x^2)", params={"variable": "x"})
        again = compute({"operation": "evaluate", "input": {"ast": r["exact"]["ast"]}})
        self.assertEqual(again["exact"]["plain"], "2*x*cos(x^2)")


class Rejections(unittest.TestCase):
    def rejects(self, src, code=None):
        with self.assertRaises(CasError) as cm:
            run("evaluate", src)
        if code:
            self.assertEqual(cm.exception.code, code)

    def test_python_shaped_input(self):
        for s in ["__import__('os')", "().__class__", "a.b", "open('/etc/passwd')", "lambda x: x", "x[0]", "[i for i in x]", "exec('1')", "sin(x", "", "1 +", "x;y"]:
            self.rejects(s)

    def test_unknown_function_rejected_before_compute(self):
        self.rejects("system(1)", "unsupported")
        with self.assertRaises(CasError):
            run("evaluate", "eval(1)")

    def test_limits(self):
        self.rejects("10^100000", "resource_limit")
        self.rejects("100000!", "resource_limit")
        self.rejects("1" * 400, "resource_limit")
        self.rejects("(" * 80 + "1" + ")" * 80, "resource_limit")
        self.rejects("x+" * 3000 + "x", "resource_limit")
        with self.assertRaises(CasError):
            run("matrix", "[" + ",".join(["[" + ",".join(["1"] * 9) + "]"] * 9) + "]", params={"mode": "determinant"})
        with self.assertRaises(CasError):
            compute({"operation": "evaluate", "input": {"text": "1"}, "precision": 5000})

    def test_domain(self):
        self.rejects("1/0", "domain")
        with self.assertRaises(CasError):
            run("matrix", "[[1,2],[2,4]]", params={"mode": "inverse"})
        with self.assertRaises(CasError) as cm:
            run("evaluate", "x", input={"ast": {"node": "call", "fn": "__import__", "args": [{"node": "integer", "value": "1"}]}})
        self.assertIn(cm.exception.code, ("unsupported", "syntax"))


if __name__ == "__main__":
    unittest.main()
