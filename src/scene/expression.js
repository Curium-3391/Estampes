// A small, closed math language for plotted functions. Expressions come
// from the model or the user, so they are never handed to eval/Function:
// they are tokenized, parsed into a tree with hard size limits and
// evaluated by walking that tree. Only the operators, constants and
// functions listed here exist; anything else is a parse error.
//
//   2*sin(x)^2 + x/3      implicit multiplication: 2x, 3(x+1), (x+1)(x-1), 2pi
//   |x| - 1               absolute value bars
//   -x^2                  means -(x^2); ^ is right-associative
//   log(x) = log10, ln(x) = natural log (the usual graphing convention)
export const MAX_EXPRESSION_LENGTH = 256;
const MAX_TOKENS = 200, MAX_NODES = 200, MAX_DEPTH = 32;

export const CONSTANTS = Object.freeze({ pi: Math.PI, "π": Math.PI, tau: 2 * Math.PI, e: Math.E });
const F = (arity, fn) => ({ arity, fn });
export const FUNCTIONS = Object.freeze({
  sin: F(1, Math.sin), cos: F(1, Math.cos), tan: F(1, Math.tan),
  sec: F(1, (x) => 1 / Math.cos(x)), csc: F(1, (x) => 1 / Math.sin(x)), cot: F(1, (x) => 1 / Math.tan(x)),
  asin: F(1, Math.asin), acos: F(1, Math.acos), atan: F(1, Math.atan), atan2: F(2, Math.atan2),
  arcsin: F(1, Math.asin), arccos: F(1, Math.acos), arctan: F(1, Math.atan),
  sinh: F(1, Math.sinh), cosh: F(1, Math.cosh), tanh: F(1, Math.tanh),
  asinh: F(1, Math.asinh), acosh: F(1, Math.acosh), atanh: F(1, Math.atanh),
  exp: F(1, Math.exp), ln: F(1, Math.log), log: F(1, Math.log10), log10: F(1, Math.log10), log2: F(1, Math.log2),
  sqrt: F(1, Math.sqrt), cbrt: F(1, Math.cbrt), abs: F(1, Math.abs), sign: F(1, Math.sign),
  floor: F(1, Math.floor), ceil: F(1, Math.ceil), round: F(1, Math.round), trunc: F(1, Math.trunc),
  min: F(-2, Math.min), max: F(-2, Math.max), pow: F(2, Math.pow), hypot: F(-2, Math.hypot),
  mod: F(2, (a, b) => ((a % b) + b) % b),
});

export class ExpressionError extends Error {
  constructor(message, at) { super(at === undefined ? message : message + " (at character " + (at + 1) + ")"); this.at = at; }
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { tokens.push({ t: "num", v: Number(num[0]), at: i }); i += num[0].length; continue; }
    const id = /^([A-Za-z_][A-Za-z0-9_]*|π)/.exec(src.slice(i));
    if (id) { tokens.push({ t: "id", v: id[0], at: i }); i += id[0].length; continue; }
    if (src.startsWith("**", i)) { tokens.push({ t: "op", v: "^", at: i }); i += 2; continue; }
    const op = { "×": "*", "·": "*", "÷": "/", "−": "-" }[c] ?? c;
    if ("+-*/^(),|".includes(op)) { tokens.push({ t: "op", v: op, at: i }); i++; continue; }
    throw new ExpressionError("Unexpected character " + JSON.stringify(c), i);
  }
  if (tokens.length > MAX_TOKENS) throw new ExpressionError("Expression is too long (more than " + MAX_TOKENS + " tokens)");
  return tokens;
}

// Recursive descent over the token list. `vars` is the set of variable
// names this expression may use (for example x, or t for a curve).
export function parseExpression(source, { variables = ["x"] } = {}) {
  const src = String(source ?? "");
  if (!src.trim()) throw new ExpressionError("Expression is empty");
  if (src.length > MAX_EXPRESSION_LENGTH) throw new ExpressionError("Expression is longer than " + MAX_EXPRESSION_LENGTH + " characters");
  const vars = new Set(variables);
  const tokens = tokenize(src);
  let pos = 0, nodes = 0, depth = 0, bars = 0;
  const peek = () => tokens[pos];
  const at = () => peek()?.at ?? src.length;
  const isOp = (v) => peek()?.t === "op" && peek().v === v;
  const node = (n) => { if (++nodes > MAX_NODES) throw new ExpressionError("Expression is too complex"); return n; };
  const enter = () => { if (++depth > MAX_DEPTH) throw new ExpressionError("Expression is nested too deeply", at()); };
  const expect = (v) => { if (!isOp(v)) throw new ExpressionError("Expected " + JSON.stringify(v), at()); pos++; };

  function expr() {
    enter();
    let left = term();
    while (isOp("+") || isOp("-")) { const op = tokens[pos++].v; left = node({ k: "bin", op, a: left, b: term() }); }
    depth--;
    return left;
  }
  // Can the next token start a factor, for implicit multiplication? A bar
  // only opens a new |...| when we are not inside one waiting for its end.
  const startsFactor = () => {
    const t = peek();
    return t && (t.t === "num" || t.t === "id" || (t.t === "op" && (t.v === "(" || (t.v === "|" && bars === 0))));
  };
  function term() {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) { const op = tokens[pos++].v; left = node({ k: "bin", op, a: left, b: unary() }); continue; }
      if (startsFactor()) { left = node({ k: "bin", op: "*", a: left, b: power() }); continue; }
      return left;
    }
  }
  function unary() {
    if (isOp("-")) { pos++; enter(); const n = node({ k: "neg", a: unary() }); depth--; return n; }
    if (isOp("+")) { pos++; return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (isOp("^")) { pos++; enter(); const n = node({ k: "bin", op: "^", a: base, b: unary() }); depth--; return n; }
    return base;
  }
  function primary() {
    const t = peek();
    if (!t) throw new ExpressionError("Expression ends too early", src.length);
    if (t.t === "num") { pos++; return node({ k: "num", v: t.v }); }
    if (t.t === "id") {
      pos++;
      const name = t.v;
      if (Object.hasOwn(FUNCTIONS, name)) {
        const f = FUNCTIONS[name];
        // sin x and sin 2x are common shorthand: one factor without brackets.
        if (!isOp("(")) {
          if (f.arity !== 1 || !startsFactor()) throw new ExpressionError(name + " needs brackets, e.g. " + name + "(x)", at());
          return node({ k: "call", name, args: [power()] });
        }
        pos++;
        const args = [];
        if (!isOp(")")) { args.push(expr()); while (isOp(",")) { pos++; args.push(expr()); } }
        expect(")");
        const ok = f.arity > 0 ? args.length === f.arity : args.length >= -f.arity;
        if (!ok) throw new ExpressionError(name + " takes " + (f.arity > 0 ? f.arity : "at least " + -f.arity) + " argument(s)", t.at);
        return node({ k: "call", name, args });
      }
      if (vars.has(name)) return node({ k: "var", name });
      if (Object.hasOwn(CONSTANTS, name)) return node({ k: "num", v: CONSTANTS[name], name });
      // xy, 2xsin(x): split a run of letters into known names when possible.
      const split = splitName(name, vars);
      if (split) { pos--; tokens.splice(pos, 1, ...split.map((v) => ({ t: "id", v, at: t.at }))); return primary(); }
      throw new ExpressionError("Unknown name " + JSON.stringify(name) + " (variables: " + [...vars].join(", ") + ")", t.at);
    }
    if (t.v === "(") { pos++; const inner = expr(); expect(")"); return inner; }
    if (t.v === "|") {
      pos++; bars++;
      const inner = expr();
      bars--;
      expect("|");
      return node({ k: "call", name: "abs", args: [inner] });
    }
    throw new ExpressionError("Unexpected " + JSON.stringify(t.v), t.at);
  }

  const tree = expr();
  if (pos < tokens.length) throw new ExpressionError("Unexpected " + JSON.stringify(peek().v), at());
  return { source: src.trim(), variables: [...vars], tree, nodes };
}

// "xsin" -> ["x", "sin"]: greedy split into variables, constants and
// functions. Returns null when the run cannot be split completely.
function splitName(name, vars) {
  const known = [...vars, ...Object.keys(CONSTANTS), ...Object.keys(FUNCTIONS)].sort((a, b) => b.length - a.length);
  const out = [];
  let rest = name;
  while (rest) {
    const hit = known.find((k) => rest.startsWith(k));
    if (!hit) return null;
    out.push(hit);
    rest = rest.slice(hit.length);
  }
  return out.length > 1 ? out : null;
}

function evaluate(n, scope) {
  switch (n.k) {
    case "num": return n.v;
    case "var": return scope[n.name];
    case "neg": return -evaluate(n.a, scope);
    case "call": return FUNCTIONS[n.name].fn(...n.args.map((a) => evaluate(a, scope)));
    case "bin": {
      const a = evaluate(n.a, scope), b = evaluate(n.b, scope);
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
      }
    }
  }
  throw new ExpressionError("Bad expression tree");
}

// parse once, evaluate many times. Non-finite results come back as NaN so
// a sampler can treat them as gaps.
export function compileExpression(source, options) {
  const parsed = parseExpression(source, options);
  const [v0] = parsed.variables;
  const fn = (value) => {
    const y = evaluate(parsed.tree, typeof value === "object" ? value : { [v0]: value });
    return Number.isFinite(y) ? y : NaN;
  };
  return Object.assign(fn, { source: parsed.source, variables: parsed.variables, usesTrig: usesTrig(parsed.tree) });
}

const TRIG = new Set(["sin", "cos", "tan", "sec", "csc", "cot"]);
function usesTrig(n) {
  if (n.k === "call") return TRIG.has(n.name) || n.args.some(usesTrig);
  if (n.k === "bin") return usesTrig(n.a) || usesTrig(n.b);
  if (n.k === "neg") return usesTrig(n.a);
  return false;
}

// Canonical text for a parsed expression (used in labels).
export function formatExpression(source) {
  return String(source).trim().replace(/\s+/g, " ");
}
