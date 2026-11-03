// Observes the real Linux flock path. Synthetic errors are enabled only by
// the lease tests and only for the exact lock in their disposable fixture.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const spawn = childProcess.spawn;
const record = fields => {
  if (process.env.PR1D_LEASE_TRACE) appendFileSync(process.env.PR1D_LEASE_TRACE, JSON.stringify(fields) + "\n");
};

childProcess.spawn = function (file, args, ...options) {
  if (file !== "/usr/bin/flock") return spawn.call(this, file, args, ...options);
  const mode = args[4] === process.env.PR1D_LEASE_ROOT + "/WRITER.lock" ? process.env.PR1D_LEASE_INJECTION : null;
  const binary = mode === "missing" ? join(process.env.PR1D_LEASE_ROOT, "no-flock") : file;
  const child = spawn.call(this, binary, args, ...options);
  child.once("exit", (code, signal) => record({event: "exit", pid: child.pid, code, signal}));
  child.once("error", error => record({event: "child-error", pid: child.pid, code: error.code}));
  child.once("spawn", () => {
    const delay = Number(process.env.PR1D_SPAWN_DELAY_MS ?? 0);
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  });
  const send = child.send;
  child.send = function (message, callback) {
    if (message.id !== 0) return send.call(this, message, callback);
    if (mode === "transport") {
      queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("Injected startup transport error"), {code: "EIO"}));
        child.kill("SIGKILL");
      });
      return false;
    }
    if (mode === "callback") {
      queueMicrotask(() => callback(Object.assign(new Error("Injected callback failure"), {code: "EIO"})));
      return false;
    }
    return send.call(this, message, error => {
      record({event: "startup-send", pid: child.pid, code: error?.code ?? null});
      callback(error);
    });
  };
  return child;
};
syncBuiltinESMExports();
