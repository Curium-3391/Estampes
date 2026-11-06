// One-shot test observer for a root created by cache-ack-race.mjs. Simulates
// an external modification immediately after a real generation read.
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManagedFiles } from "../../src/persistence/filesystem.js";

const root = process.env.PR1D_CACHE_RACE_ROOT;
if (root && process.argv[1]?.endsWith("/persistence/worker.js") && process.argv[2] === root) {
  const json = ManagedFiles.prototype.json;
  const trigger = join(root, "test-read-race-trigger");
  const done = join(root, "test-read-race-observed");
  ManagedFiles.prototype.json = async function (path, ...args) {
    const result = await json.call(this, path, ...args);
    if (this.root !== root || !path.startsWith("visual-documents/")) return result;
    const target = await readFile(trigger, "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (path === target) {
      await unlink(trigger);
      await writeFile(this.path(path), "{}");
      await writeFile(done, path);
    }
    return result;
  };
}
