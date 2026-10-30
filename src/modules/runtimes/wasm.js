// Isolated runtime for WebAssembly modules (ABI "estampes.wasm/1").
//
// A module is one .wasm file inside the signed package. It must import
// nothing: it gets no clock, no network, no files and no host functions, so
// everything it can do is compute on the bytes it is given. Each call runs
// in a fresh child process with a time limit (the process is killed when it
// runs out; a crash while allocating only ever takes down the child), a memory limit (the module has to declare a maximum no larger
// than limits.memoryMb, checked from the binary before it ever runs) and an
// output limit (limits.outputKb). State never carries over between calls.
//
// ABI: the module exports `memory`, `alloc(len) -> ptr` and
// `handle(ptr, len) -> ptr`. The host writes a JSON request
// {capability, params, module, canvas} at the pointer from alloc; handle
// returns a pointer to a 4-byte little-endian length followed by that many
// bytes of JSON {operations, summary, data, method}. See docs/MODULES.md.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export const WASM_ABI = "estampes.wasm/1";
export const MAX_WASM_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIME_MS = 2000, DEFAULT_MEMORY_MB = 16, DEFAULT_OUTPUT_KB = 256;
const PAGE = 65536;
const WORKER = fileURLToPath(new URL("./wasm-worker.js", import.meta.url));

export class WasmError extends Error {}

function leb(bytes, at) {
  let value = 0, shift = 0, i = at;
  for (;;) {
    if (i >= bytes.length || shift > 28) throw new WasmError("malformed WebAssembly binary");
    const b = bytes[i++];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) return [value, i];
  }
}

const MAX_TABLE_ELEMENTS = 10000;

// Reads the module's own memory and table declarations straight from the
// binary, so their sizes are known before anything is allocated.
export function declaredSizes(bytes) {
  let at = 8, memory = null;
  const tables = [];
  const limits = (p) => {
    const flags = bytes[p++];
    if (flags !== 0 && flags !== 1) throw new WasmError("shared, 64-bit or otherwise extended memory or tables are not allowed");
    let min, max = null; [min, p] = leb(bytes, p);
    if (flags & 0x01) [max, p] = leb(bytes, p);
    return [{ min, max }, p];
  };
  while (at < bytes.length) {
    const id = bytes[at++];
    let size; [size, at] = leb(bytes, at);
    const end = at + size;
    if (end > bytes.length) throw new WasmError("malformed WebAssembly binary");
    if (id === 4 || id === 5) {
      let count, p = at; [count, p] = leb(bytes, p);
      if (count > 16) throw new WasmError("too many " + (id === 4 ? "tables" : "memories"));
      for (let i = 0; i < count; i++) {
        // Only the one-byte reference types; anything else cannot be sized here.
        if (id === 4 && bytes[p++] !== 0x70 && bytes[p - 1] !== 0x6f) throw new WasmError("unsupported table type");
        let l; [l, p] = limits(p);
        if (id === 4) tables.push(l); else memory = memory ? (() => { throw new WasmError("the module must declare exactly one memory"); })() : l;
      }
    }
    at = end;
  }
  return { memory, tables };
}

// Everything that can be checked without running the module.
export function inspectWasm(bytes, { memoryMb = DEFAULT_MEMORY_MB } = {}) {
  if (bytes.length > MAX_WASM_BYTES) throw new WasmError("the WebAssembly file is larger than " + MAX_WASM_BYTES / 1024 / 1024 + " MB");
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new WasmError("not a WebAssembly file");
  if (!WebAssembly.validate(bytes)) throw new WasmError("the WebAssembly file is not valid");
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length) throw new WasmError("the module imports " + imports.map((i) => i.module + "." + i.name).join(", ") + "; modules may not import anything");
  const exported = new Map(WebAssembly.Module.exports(module).map((e) => [e.name, e.kind]));
  for (const [name, kind] of [["memory", "memory"], ["alloc", "function"], ["handle", "function"]]) {
    if (exported.get(name) !== kind) throw new WasmError("the module must export " + kind + " `" + name + "`");
  }
  const { memory: mem, tables } = declaredSizes(bytes);
  if (!mem) throw new WasmError("the module declares no memory");
  for (const t of tables) {
    if (t.min > MAX_TABLE_ELEMENTS || t.max === null || t.max > MAX_TABLE_ELEMENTS) throw new WasmError("a table may hold at most " + MAX_TABLE_ELEMENTS + " entries and must declare its maximum");
  }
  const maxPages = Math.floor(memoryMb * 1024 * 1024 / PAGE);
  if (mem.max === null) throw new WasmError("the module must declare a maximum memory size");
  if (mem.max > maxPages || mem.min > maxPages) throw new WasmError("the module asks for up to " + Math.ceil(mem.max * PAGE / 1024 / 1024) + " MB of memory; limits.memoryMb allows " + memoryMb);
  return { module, memory: mem };
}

export function wasmFileOf(manifest, files) {
  const f = files?.[manifest.runtime.entry];
  if (!f) throw new WasmError("the package has no file " + manifest.runtime.entry + " (runtime.entry)");
  if (f.encoding !== "base64") throw new WasmError(manifest.runtime.entry + " must be stored as base64");
  return Buffer.from(f.content, "base64");
}

// Called when a package is verified: reject a module that could not run.
export function checkWasmPackage(manifest, files) {
  if (manifest.runtime.abi && manifest.runtime.abi !== WASM_ABI) throw new WasmError("unknown WebAssembly ABI " + manifest.runtime.abi + " (supported: " + WASM_ABI + ")");
  inspectWasm(wasmFileOf(manifest, files), { memoryMb: manifest.limits?.memoryMb ?? DEFAULT_MEMORY_MB });
}

function runInChild(wasm, request, { timeMs, outputBytes, maxPages }) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], { env: {}, execArgv: ["--max-old-space-size=64", "--stack-size=900"], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
    let done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); child.kill("SIGKILL"); fn(value); };
    const timer = setTimeout(() => finish(reject, new WasmError("the module ran longer than " + timeMs + " ms and was stopped")), timeMs);
    child.once("message", (m) => (m?.error ? finish(reject, new WasmError(m.error)) : finish(resolve, m?.result)));
    child.once("error", (e) => finish(reject, new WasmError("the module could not start: " + (e?.message ?? e))));
    child.once("exit", (code, signal) => finish(reject, new WasmError("the module stopped unexpectedly (" + (signal ?? "exit " + code) + "), for example by running out of memory")));
    child.send({ wasm: wasm.toString("base64"), request, outputBytes, maxPages });
  });
}

// runtime object stored in the catalog: { kind: "wasm", wasm: Buffer }
export const wasmRuntime = {
  kind: "wasm",
  async run(mod, capability, params, ctx = {}) {
    const { manifest, runtime } = mod;
    const limits = manifest.limits ?? {};
    if (!runtime?.wasm) throw new WasmError("the module's WebAssembly file is not loaded");
    const memoryMb = limits.memoryMb ?? DEFAULT_MEMORY_MB;
    runtime.compiled ??= inspectWasm(runtime.wasm, { memoryMb });
    const request = JSON.stringify({ capability, params, module: ctx.module ?? { id: manifest.id, version: manifest.version }, canvas: ctx.canvas ?? null });
    const out = await runInChild(runtime.wasm, request, {
      timeMs: limits.timeMs ?? DEFAULT_TIME_MS, outputBytes: (limits.outputKb ?? DEFAULT_OUTPUT_KB) * 1024, maxPages: Math.floor(memoryMb * 1024 * 1024 / PAGE),
    });
    let parsed;
    try { parsed = JSON.parse(out); } catch { throw new WasmError("the module did not return valid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WasmError("the module result must be a JSON object");
    return { method: "WebAssembly module", ...parsed };
  },
};
