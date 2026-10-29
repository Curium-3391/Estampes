import test from "node:test";
import assert from "node:assert/strict";
import {valueToX,xToValue,nearestTick,validateTick} from "../src/geometry.js";
test("all ticks round trip",()=>{
  for(let value=-4;value<=4;value++) {
    assert.equal(xToValue(valueToX(value)),value);
    assert.equal(nearestTick(valueToX(value)),value);
  }
});
test("midpoint mapping",()=>assert.equal(valueToX(0),0.5));
test("clamping",()=>{assert.equal(nearestTick(-10),-4);assert.equal(nearestTick(10),4)});
test("invalid inputs",()=>{assert.throws(()=>validateTick(4.5));assert.throws(()=>validateTick(9));});
