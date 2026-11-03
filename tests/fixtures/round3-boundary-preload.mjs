import {readFile, writeFile, rename, unlink} from "node:fs/promises";
import {join} from "node:path";
import {ManagedFiles, physicalFingerprint} from "../../src/persistence/filesystem.js";

const root = process.env.PR1D_ROUND3_FAULT_ROOT;
if (root && process.argv[1]?.endsWith("/persistence/worker.js") && process.argv[2] === root) {
  const point = ManagedFiles.prototype.point;
  const trigger = join(root, "round3-trigger.json");
  const observed = join(root, "round3-observed.json");
  const points = new Set(["after-prepared", "current.before-rename", "before-ack", "gc.before-unlink"]);
  ManagedFiles.prototype.point = async function (name, details) {
    if (this.root === root && points.has(name)) {
      const text = await readFile(trigger, "utf8").catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (text !== null) {
        const fault = JSON.parse(text);
        if (fault.point === name && (!fault.pointPath || fault.pointPath === details?.path)) {
          await unlink(trigger);
          const before = physicalFingerprint(await this.info(fault.target));
          if (fault.mode === "replace" || fault.mode === "replace-same") {
            const replacement = join(root, "round3-replacement");
            await writeFile(replacement, fault.mode === "replace-same" ? await readFile(this.path(fault.target)) : "{}");
            await rename(replacement, this.path(fault.target));
          } else await writeFile(this.path(fault.target), "{}");
          const after = physicalFingerprint(await this.info(fault.target));
          await writeFile(observed, JSON.stringify({...fault, before, after, workerPid: process.pid}));
        }
      }
    }
    return point.call(this, name, details);
  };
}
