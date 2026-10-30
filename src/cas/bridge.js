// Turns a CAS result (estampes.math-ast/1) into an expression the Graph's
// own parser accepts. Only listed nodes and functions convert; anything
// else (complex values, other symbols, opaque nodes) is refused so a
// result that is not an ordinary real function never plots as one.
import { compileExpression, FUNCTIONS } from "../scene/expression.js";

export class BridgeError extends Error {}

const PREC = { add: 1, mul: 2, div: 2, neg: 2, pow: 3 };
const CALLS = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "exp", "ln", "abs", "sign", "floor", "sqrt", "cbrt", "min", "max", "mod"]);
const RENAME = { ceil: "ceil" };

export function freeSymbols(ast, out = new Set()) {
  if (!ast || typeof ast !== "object") return out;
  if (ast.node === "symbol") out.add(ast.name);
  for (const v of Object.values(ast)) {
    if (Array.isArray(v)) v.forEach((x) => freeSymbols(x, out));
    else if (v && typeof v === "object") freeSymbols(v, out);
  }
  return out;
}

export function astToGraph(ast) {
  const symbols = [...freeSymbols(ast)];
  if (symbols.length > 1) throw new BridgeError("the result has several variables (" + symbols.join(", ") + "); Graph plots y = f(x) with one variable");
  const variable = symbols[0] ?? "x";
  let nodes = 0;
  const wrap = (s, need, have) => (have < need ? "(" + s + ")" : s);
  const prec = (n) => PREC[n.node] ?? (n.node === "integer" && n.value.startsWith("-") ? 1 : n.node === "rational" ? 2 : 4);
  const emit = (n) => {
    if (++nodes > 400) throw new BridgeError("the result is too large to plot");
    switch (n?.node) {
      case "integer": return n.value;
      case "rational": return n.num + "/" + n.den;
      case "float": return String(n.value).replace(/\*\^/, "e");
      case "constant":
        if (n.name === "pi" || n.name === "e") return n.name;
        throw new BridgeError(n.name === "I" ? "the result is complex-valued" : "the result contains " + n.name);
      case "symbol": return "x";
      case "neg": return "-" + wrap(emit(n.arg), 3, prec(n.arg));
      case "add": return n.args.map((a, i) => { const s = emit(a); return i && /^-/.test(s) ? s : (i ? "+" : "") + s; }).join("");
      case "mul": return n.args.map((a) => wrap(emit(a), 2, prec(a) === 2 && a.node !== "mul" && a.node !== "rational" ? 3 : prec(a))).join("*");
      case "div": return wrap(emit(n.left), 2, prec(n.left)) + "/" + wrap(emit(n.right), 3, prec(n.right));
      case "pow": return wrap(emit(n.left), 4, prec(n.left)) + "^" + wrap(emit(n.right), 4, prec(n.right));
      case "call": {
        const fn = RENAME[n.fn] ?? n.fn;
        if (!CALLS.has(fn) && fn !== "ceil") throw new BridgeError("Graph cannot plot " + String(n.fn).slice(0, 20) + "()");
        if (!FUNCTIONS[fn]) throw new BridgeError("Graph does not know " + fn + "()");
        return fn + "(" + n.args.map(emit).join(",") + ")";
      }
      default: throw new BridgeError("the result (" + (n?.node ?? "?") + ") cannot be drawn as a function of x");
    }
  };
  const expression = emit(ast);
  const fn = compileExpression(expression);
  return { expression: fn.source, variable, fn };
}

// A plottable result is a real, exact or approximate scalar function.
export function checkPlottable(result, domain = [-10, 10]) {
  if (!result || !["exact", "approximate"].includes(result.status)) {
    throw new BridgeError("a result with status " + (result?.status ?? "unknown") + " is not an ordinary real function, so it is not plotted");
  }
  const g = astToGraph(result.exact?.ast);
  let finite = 0;
  for (let i = 0; i <= 200; i++) if (Number.isFinite(g.fn(domain[0] + ((domain[1] - domain[0]) * i) / 200))) finite++;
  if (finite < 3) throw new BridgeError("the result has no real values on [" + domain[0] + ", " + domain[1] + "]");
  return g;
}
