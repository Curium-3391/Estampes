// HTTP modules: example mockResponse runs the reply through the same response
// mapping a real call uses, offline; `expect` checks results and errors for
// every runtime; the install self-test applies the same rules.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../src/modules/manifest.js";
import { selfTest, firstMismatch } from "../src/modules/packages.js";
import { declarativeRuntime } from "../src/modules/runtimes/declarative.js";
import { createHttpRuntime, mapResponse } from "../src/modules/runtimes/http.js";
import { createEgress, createSecrets } from "../src/modules/egress.js";

const cli = (cwd, ...args) => spawnSync(process.execPath, [join(process.cwd(), "scripts/estampes-module.js"), ...args], { cwd, env: { ...process.env, ESTAMPES_STORAGE_DIR: cwd }, encoding: "utf8" });
const neverSend = () => { throw new Error("a self-test must never open a connection"); };
const runtimes = { declarative: declarativeRuntime, http: createHttpRuntime({ egress: createEgress({ secrets: createSecrets({}), transport: neverSend }) }) };
const ocr = async () => JSON.parse(await readFile("examples/modules/ocr-http/module.json", "utf8"));
const withExamples = (m, examples) => { m.capabilities[0].examples = examples; return validateManifest(m); };

test("mockResponse runs the response mapping offline and checks expect", async () => {
  const m = validateManifest(await ocr());
  const report = await selfTest(m, { kind: "http" }, { runtimes });
  assert.deepEqual(report, { examples: 3, mocked: 3, untested: [] });
});

test("a mapping typo, a wrong expectation and an unexpected success are caught", async () => {
  const ok = { description: "ok", params: { text: "hi" }, mockResponse: { json: { result: { text: "hi" } } } };
  let m = await ocr();
  m.capabilities[0].response.operations[0].props.text = { $response: "result.txt" };
  await assert.rejects(selfTest(withExamples(m, [ok]), { kind: "http" }, { runtimes }), /"result\.txt" not found in the reply/);
  m = await ocr();
  await assert.rejects(selfTest(withExamples(m, [{ ...ok, expect: { data: { text: "bye" } } }]), { kind: "http" }, { runtimes }), /data\.text: expected "bye", got "hi"/);
  m = await ocr();
  await assert.rejects(selfTest(withExamples(m, [{ ...ok, expect: { operations: 2 } }]), { kind: "http" }, { runtimes }), /expected 2 operation\(s\), got 1/);
  m = await ocr();
  await assert.rejects(selfTest(withExamples(m, [{ ...ok, expect: { error: "answered" } }]), { kind: "http" }, { runtimes }), /expected an error containing "answered", but the call succeeded/);
  m = await ocr();
  await assert.rejects(selfTest(withExamples(m, [{ ...ok, mockResponse: { text: "<html>busy</html>" } }]), { kind: "http" }, { runtimes }), /did not answer with JSON/);
  m = await ocr();
  await assert.rejects(selfTest(withExamples(m, [{ ...ok, mockResponse: { status: 302, json: {} } }]), { kind: "http" }, { runtimes }), /redirect \(302\)/);
  // A bad scene operation built from the reply is refused like in a real call.
  m = await ocr();
  await assert.rejects(selfTest(withExamples(m, [{ ...ok, mockResponse: { json: { result: { text: "x".repeat(200) } } } }]), { kind: "http" }, { runtimes }), /self-test of read_text: operations\[0\]/);
});

test("the request is still checked when a mock is given; secrets are never read", async () => {
  const m = await ocr();
  m.capabilities[0].request.path = "/v1/../admin";
  assert.throws(() => validateManifest(m), /path/);
  const m2 = await ocr();
  m2.capabilities[0].request.secretHeaders.Cookie = { secret: "api_key" };
  await assert.rejects(selfTest(validateManifest(m2), { kind: "http" }, { runtimes }), /secret header "Cookie" is not allowed/);
});

test("manifest rules for mockResponse and expect", async () => {
  const callout = JSON.parse(await readFile("examples/modules/callout/module.json", "utf8"));
  callout.capabilities[0].examples[0].mockResponse = { json: {} };
  assert.throws(() => validateManifest(callout), /mockResponse: only for the http runtime/);
  let m = await ocr();
  assert.throws(() => withExamples(m, [{ description: "x", params: { text: "a" }, expect: { operations: 1 } }]), /can only check a result against a mockResponse/);
  m = await ocr();
  assert.throws(() => withExamples(m, [{ description: "x", params: { text: "a" }, mockResponse: { json: {}, text: "{}" } }]), /json or text, not both/);
  m = await ocr();
  assert.throws(() => withExamples(m, [{ description: "x", params: { text: "a" }, mockResponse: { json: {} }, expect: { error: "e", operations: 1 } }]), /cannot also expect a result/);
  m = await ocr();
  assert.throws(() => withExamples(m, [{ description: "x", params: { text: "a" }, mockResponse: { json: { big: "x".repeat(70000) } } }]), /larger than 64 KB/);
});

test("expect works for declarative modules and for refused input", async () => {
  const callout = JSON.parse(await readFile("examples/modules/callout/module.json", "utf8"));
  const cap = callout.capabilities[0];
  const params = cap.examples[0].params;
  cap.examples = [{ description: "ok", params, expect: { operations: cap.operations.length } }];
  assert.equal((await selfTest(validateManifest(callout), { kind: "declarative" }, { runtimes })).examples, 1);
  cap.examples = [{ description: "bad", params: { ...params, nope: 1 }, expect: { error: "nope" } }];
  assert.equal((await selfTest(validateManifest(callout), { kind: "declarative" }, { runtimes })).examples, 1);
});

test("expect.data is a pattern with a floating point tolerance", () => {
  assert.equal(firstMismatch({ a: 0.1 + 0.2 }, { a: 0.3, b: 1 }, "data"), null);
  assert.equal(firstMismatch([1, 2], [1, 2, 3], "data"), "data: expected 2 item(s), got 3");
  assert.equal(firstMismatch({ a: { b: "x" } }, { a: null }, "data"), "data.a: expected an object, got null");
  assert.equal(firstMismatch(1, 1.01, "data"), "data: expected 1, got 1.01");
});

test("real calls and mocks share one mapping", async () => {
  const m = validateManifest(await ocr());
  const out = mapResponse(m, m.capabilities[0], { text: "a", x: 0.5 }, Buffer.from(JSON.stringify({ result: { text: "A" } })));
  assert.equal(out.operations[0].props.text, "A");
  assert.equal(out.operations[0].props.x, 0.5);
  assert.deepEqual(out.data, { text: "A" });
});

test("module test reports mocks and warns about untested mappings", async () => {
  const work = await mkdtemp(join(tmpdir(), "estampes-mock-"));
  try {
    let r = cli(work, "init", "svc", "org.example.svc", "--runtime", "http");
    assert.equal(r.status, 0, r.stderr);
    r = cli(work, "test", "svc/module.json");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^OK org\.example\.svc 0\.1\.0: manifest valid, 2 example\(s\) passed \(2 with a mock response\)$/m);
    const m = JSON.parse(await readFile(join(work, "svc/module.json"), "utf8"));
    for (const ex of m.capabilities[0].examples) { delete ex.mockResponse; delete ex.expect; }
    await writeFile(join(work, "nomock.json"), JSON.stringify(m));
    r = cli(work, "test", "nomock.json");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /warning: analyze_text \(The service answers\): response mapping not tested; add a mockResponse/);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test("templates: $each, $item, $index and as: string", async () => {
  const { fillTemplate } = await import("../src/modules/runtimes/declarative.js");
  const reply = { rows: [{ k: "a", v: 1 }, { k: "b", v: 2.5 }, { k: "c", v: true }] };
  const tpl = [{ title: "t" }, { $each: { $response: "rows" }, max: 2, do: { n: { $index: 1, as: "string" }, label: { $item: "k" }, value: { $item: "v", as: "string" } } }];
  assert.deepEqual(fillTemplate(tpl, {}, 0, reply), [{ title: "t" }, { n: "1", label: "a", value: "1" }, { n: "2", label: "b", value: "2.5" }]);
  // nesting reads the innermost item; "." is the whole item
  assert.deepEqual(fillTemplate([{ $each: { $param: "g" }, do: { items: [{ $each: { $item: "xs" }, do: { $item: "." } }] } }], { g: [{ xs: [1, 2] }, { xs: [] }] }), [{ items: [1, 2] }, { items: [] }]);
  // a missing list gives nothing; a missing item field is reported in self-tests
  const missing = [];
  assert.deepEqual(fillTemplate([{ $each: { $response: "nope" }, do: 1 }], {}, 0, reply, missing), []);
  fillTemplate([{ $each: { $response: "rows" }, do: { $item: "zz" } }], {}, 0, reply, missing);
  assert.deepEqual([...new Set(missing)], ["nope", "$item zz"]);
  assert.throws(() => fillTemplate({ $item: "x" }, {}), /only allowed inside \$each/);
  assert.throws(() => fillTemplate([{ $each: { $param: "s" }, do: 1 }], { s: "abc" }), /needs a list/);
  assert.throws(() => fillTemplate([{ $each: { $param: "s" }, do: 1, max: 500 }], { s: [] }), /max must be/);
  assert.throws(() => fillTemplate([{ $each: { $param: "s" } }], { s: [] }), /\$each takes/);
});

test("http image upload: manifest rules and refusals", async () => {
  const regions = async () => JSON.parse(await readFile("examples/modules/regions/module.json", "utf8"));
  let m = await regions();
  m.permissions = m.permissions.filter((p) => p !== "asset.read.selected");
  assert.throws(() => validateManifest(m), /needs asset\.read\.selected/);
  m = await regions();
  m.capabilities[0].target = "none";
  assert.throws(() => validateManifest(m), /needs a target canvas/);
  m = await regions();
  m.capabilities[0].request.method = "GET";
  assert.throws(() => validateManifest(m), /only POST may carry a body/);
  m = await regions();
  m.capabilities[0].request.body = { a: 1 };
  assert.throws(() => validateManifest(m), /one body/);
  m = await regions();
  m.capabilities[0].request.multipart.file.source = "/etc/passwd";
  assert.throws(() => validateManifest(m), /canvas-image/);

  // At run time: no readSource (permission not granted or no canvas) and a blank canvas are refused before anything is sent.
  const sent = [];
  const rt = createHttpRuntime({ egress: createEgress({ secrets: createSecrets({ env: { ESTAMPES_MODULE_SECRET_ORG_DACME_DREGIONS_SAPI_KEY: "k-123456789" } }), transport: async (r) => { sent.push(r); return { status: 200, body: Buffer.from("{}") }; } }) });
  const mod = { manifest: validateManifest(await regions()) };
  const granted = mod.manifest.permissions;
  await assert.rejects(rt.run(mod, "detect", {}, { permissions: granted }), /needs asset\.read\.selected and a canvas/);
  await assert.rejects(rt.run(mod, "detect", {}, { permissions: granted, readSource: async () => null }), /no image to send/);
  await assert.rejects(rt.run(mod, "detect", {}, { permissions: granted, readSource: async () => Buffer.from("GIF89a...") }), /not JPEG, PNG or WebP/);
  await assert.rejects(rt.run(mod, "detect", {}, { permissions: granted.filter((p) => p !== "asset.read.selected"), readSource: async () => Buffer.from([0xff, 0xd8, 0xff, 0]) }), /permission to read the image/);
  assert.equal(sent.length, 0);
});

test("templates: $calc uses the safe expression parser", async () => {
  const { fillTemplate } = await import("../src/modules/runtimes/declarative.js");
  assert.equal(fillTemplate({ $calc: "x + 0.03", with: { x: { $param: "x" } } }, { x: 0.5 }), 0.53);
  assert.equal(fillTemplate({ $calc: "2i+1", with: { i: { $param: "i" } }, as: "string" }, { i: 3 }), "7");
  assert.throws(() => fillTemplate({ $calc: "x", with: { x: { $param: "x" } } }, { x: "1" }), /x is not a number/);
  assert.throws(() => fillTemplate({ $calc: "1/x", with: { x: { $param: "x" } } }, { x: 0 }), /no finite value/);
  assert.throws(() => fillTemplate({ $calc: "constructor", with: {} }, {}), /Unknown name/);
  assert.throws(() => fillTemplate({ $calc: "x", with: { X: 1 } }, {}), /lower-case/);
});

test("module try runs one capability offline and renders the scratch canvas", async () => {
  const work = await mkdtemp(join(tmpdir(), "estampes-try-"));
  try {
    let r = cli(work, "try", join(process.cwd(), "examples/modules/markers/module.json"), "place_markers", "--params", JSON.stringify({ markers: [{ x: 0.5, y: 0.5, label: "here" }] }), "--out", "out.png");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^OK org\.acme\.markers place_markers/);
    assert.match(r.stdout, /shape:text {2}\{"kind":"text","x":0\.53/);
    const png = await readFile(join(work, "out.png"));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    r = cli(work, "try", join(process.cwd(), "examples/modules/linefit/module.json"), "fit_line", "--example", "1");
    assert.match(r.stdout, /data: \{"slope":2,"intercept":1,"r2":1,"n":4\}/);
    r = cli(work, "try", join(process.cwd(), "examples/modules/keywords/module.json"), "analyze", "--example", "1");
    assert.match(r.stdout, /mock reply/);
    assert.match(r.stdout, /info-card/);
    r = cli(work, "try", join(process.cwd(), "examples/modules/keywords/module.json"), "analyze", "--params", "{\"text\":\"x\"}");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /never calls the network/);
    r = cli(work, "try", join(process.cwd(), "examples/modules/markers/module.json"), "place_markers", "--params", "{\"markers\":[{\"x\":3,\"y\":0,\"label\":\"x\"}]}");
    assert.match(r.stderr, /must be <= 1/);
  } finally { await rm(work, { recursive: true, force: true }); }
});
