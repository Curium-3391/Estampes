import test from "node:test";
import assert from "node:assert/strict";
import { parse, jsonSchema, canonicalJson } from "../src/documents/validation.js";
import { parseVisualDocument } from "../src/documents/schema.js";
import { document } from "./fixtures/uva-persistence.mjs";

const schema=jsonSchema();
test("JSON schema canonical copy preserves Unicode, numeric and prototype-key bytes",()=>{
  const shared={z:-0,a:["\ud800","\udfff","😀","\u0000\b\f\n\r\t\"\\",1e30,Number.MIN_VALUE]};
  const input=Object.assign(Object.create(null),{z:shared,a:shared});
  Object.defineProperty(input,"__proto__",{value:{safe:true},enumerable:true});
  const output=parse(schema,input);
  assert.equal(canonicalJson(output),canonicalJson(input));
  assert.deepEqual(Object.keys(output),["__proto__","a","z"]);
  assert.notEqual(output.a,shared);assert.notEqual(output.a,output.z);
  assert.equal(Object.is(output.a.z,-0),false);
  shared.a[0]="mutated";assert.equal(output.a.a[0],"\ud800");
  assert.equal({}.safe,undefined);
});

for(const [name,make] of [
  ["prototype",()=>new Date()], ["proxy",()=>new Proxy({},{ownKeys(){throw Error("must not run");}})],
  ["accessor",()=>({get secret(){throw Error("must not run");}})],
  ["symbol",()=>({[Symbol("x")]:1})], ["hidden",()=>Object.defineProperty({},"x",{value:1})],
  ["sparse",()=>Array(2)], ["decorated array",()=>Object.assign([],{extra:true})],
  ["cycle",()=>{const v={};v.v=v;return v;}],
  ...[NaN,Infinity,-Infinity,undefined,1n,()=>{}].map((v,n)=>["non-JSON "+n,()=>v])
])test("canonical copy rejects "+name+" before encoding",()=>{
  assert.throws(()=>parse(schema,make()),e=>e.code==="INVALID_INPUT");
});

test("canonical copy preserves exact byte, nesting and node limits",()=>{
  for(const value of ["😀","\ud800","\n",{x:[1,2]}]){
    const bytes=Buffer.byteLength(canonicalJson(value));
    assert.equal(canonicalJson(parse(jsonSchema({maxBytes:bytes}),value)),canonicalJson(value));
    assert.throws(()=>parse(jsonSchema({maxBytes:bytes-1}),value),e=>e.code==="LIMIT");
  }
  assert.throws(()=>parse(jsonSchema({maxDepth:1}),{x:{y:0}}),e=>e.code==="LIMIT");
  assert.throws(()=>parse(jsonSchema({maxNodes:2}),[1,2]),e=>e.code==="LIMIT");
});

test("async JSON schema entry cannot retain a mutable value between guard and encoding",async()=>{
  const source={data:["before"]},pending=schema.parseAsync(source);
  source.data[0]=NaN;
  assert.deepEqual(await pending,{data:["before"]});
  await assert.rejects(schema.parseAsync(source));
});

test("JSON transform does not replace strict Document validation",()=>{
  const input=document();input.title=123;
  assert.throws(()=>parseVisualDocument(input),e=>e.code==="INVALID_INPUT");
});
