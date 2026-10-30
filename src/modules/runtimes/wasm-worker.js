// Runs one call of a WebAssembly module in its own process (see wasm.js).
// The only input is the module bytes and the request text, and the module has
// no imports. The parent kills this process on timeout; if the engine aborts
// (for example on an allocation failure) only this process goes down.
function main({ wasm, request, outputBytes, maxPages }) {
  const module = new WebAssembly.Module(Buffer.from(wasm, "base64"));
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

process.once("message", (job) => {
  let reply;
  try { reply = { result: main(job) }; }
  catch (error) { reply = { error: error instanceof WebAssembly.RuntimeError ? "the module trapped: " + error.message : String(error?.message ?? error) }; }
  process.send(reply, () => process.exit(0));
});
