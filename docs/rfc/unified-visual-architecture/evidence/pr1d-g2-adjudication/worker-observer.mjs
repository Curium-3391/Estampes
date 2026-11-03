import assert from "node:assert/strict";
import { resolve } from "node:path";
import { GarbageCollector } from "../src/persistence/gc.js";
import { emit, observe } from "./observe.mjs";

// This preload is enabled only on the disposable writer used for GC. Keep the
// actual plan, step, publication, and filesystem methods on the call path.
const tmpdir = resolve(process.env.TMPDIR);
assert.ok(resolve(process.argv[2]).startsWith(tmpdir + "/estampes-pr1c-pr1d-"));

for (const action of ["plan", "step"]) {
  const original = GarbageCollector.prototype[action];
  GarbageCollector.prototype[action] = async function (args) {
    const { manager, files } = this;
    const publish = manager.publish;
    const point = files.point;
    const boundary = { action, args, durability: "settled before call" };
    await observe(files.root, "gc-entry", boundary, manager);
    manager.publish = async function (name, ...rest) {
      const value = await publish.call(this, name, ...rest);
      await observe(files.root, "gc-publication", {
        action, args, name, durability: "production publish returned after CURRENT directory fsync", value,
      }, manager);
      return value;
    };
    files.point = async function (name, details) {
      await point.call(this, name, details);
      if (name.startsWith("gc.") || name === "current.after-dir-fsync" || name === "after-publication-durable") {
        emit("filesystem-stage", { action, args, name, details });
      }
    };
    try {
      const result = await original.call(this, args);
      emit("gc-result", { action, args, result });
      return result;
    } catch (error) {
      emit("gc-error", { action, args, code: error.code, message: error.message });
      throw error;
    } finally {
      manager.publish = publish;
      files.point = point;
    }
  };
}
