// Runs one call of a WebAssembly module (see wasm.js). Nothing is passed in
// but the compiled module and the request text, and the module has no imports.
import { parentPort, workerData } from "node:worker_threads";

function main() {
  const { module, request, outputBytes, maxPages } = workerData;
  const { exports } = new WebAssembly.Instance(module, {});
  const { memory, alloc, handle } = exports;
  if (memory.buffer.byteLength > maxPages * 65536) throw new Error("the module starts with more memory than allowed");
  const input = new TextEncoder().encode(request);
  const inPtr = alloc(input.length) >>> 0;
  if (inPtr + input.length > memory.buffer.byteLength) throw new Error("alloc returned a pointer outside memory");
  new Uint8Array(memory.buffer, inPtr, input.length).set(input);
  const outPtr = handle(inPtr, input.length) >>> 0;
  if (outPtr + 4 > memory.buffer.byteLength) throw new Error("handle returned a pointer outside memory");
  const length = new DataView(memory.buffer).getUint32(outPtr, true);
  if (length > outputBytes) throw new Error("the module returned " + length + " bytes; the limit is " + outputBytes);
  if (outPtr + 4 + length > memory.buffer.byteLength) throw new Error("handle returned a length outside memory");
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(memory.buffer, outPtr + 4, length));
}

try { parentPort.postMessage({ result: main() }); }
catch (error) { parentPort.postMessage({ error: error instanceof WebAssembly.RuntimeError ? "the module trapped: " + error.message : String(error?.message ?? error) }); }
