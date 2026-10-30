import test from "node:test";
import assert from "node:assert/strict";
import { compileExpression } from "../src/scene/expression.js";

const at = (src, x) => compileExpression(src)(x);

test("expressions: arithmetic, precedence, implicit multiplication, bars and constants", () => {
  assert.equal(at("2x", 3), 6);
  assert.equal(at("-x^2", 3), -9);
  assert.equal(at("2^3^2", 0), 512);
  assert.equal(at("|x|-1", -4), 3);
  assert.equal(at("(x+1)(x-1)", 3), 8);
  assert.equal(at("3(x+1)", 1), 6);
  assert.ok(Math.abs(at("2pi x", 1) - 2 * Math.PI) < 1e-12);
  assert.ok(Math.abs(at("sin(x)", Math.PI / 2) - 1) < 1e-12);
  assert.equal(at("log(100)", 0), 2);
  assert.equal(at("max(1,x,3)", 5), 5);
  assert.equal(at("x**2", 4), 16);
  assert.ok(Number.isNaN(at("1/x", 0)), "non-finite results become NaN");
});

test("expressions: anything that is not math is refused, never evaluated", () => {
  for (const bad of ["process.exit()", "x;1", "constructor", "__proto__", "alert(1)", "sin(", "1+", "x".repeat(300), "sin()", "`x`", "x=1", "a+b"]) {
    assert.throws(() => compileExpression(bad), undefined, bad);
  }
  assert.throws(() => compileExpression("(".repeat(40) + "x" + ")".repeat(40)), /deeply|complex|long/);
});

test("expressions: detects trigonometry for default axes", () => {
  assert.equal(compileExpression("2*sin(x)").usesTrig, true);
  assert.equal(compileExpression("x^2").usesTrig, false);
});
