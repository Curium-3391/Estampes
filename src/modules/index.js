// The module host: registry + lifecycle + router + audit, wired to the
// canvas store. server.js creates one; tests create their own with a
// temporary folder. Module data lives in <storage>/modules/ (or memory).
import { join } from "node:path";
import { createAudit } from "./audit.js";
import { createRegistry } from "./registry.js";
import { createLifecycle } from "./lifecycle.js";
import { createRouter } from "./router.js";
import { createDerivedIndex } from "../documents/derived-index.js";
import { newDerivedState } from "./derived-flow.js";
import { builtinRuntime } from "./runtimes/builtin.js";
import { declarativeRuntime } from "./runtimes/declarative.js";
import { wasmRuntime } from "./runtimes/wasm.js";
import { createHttpRuntime } from "./runtimes/http.js";
import { createJobs } from "./jobs.js";
import { createEgress, createSecrets } from "./egress.js";
import { createPackages, ensureDirs } from "./packages.js";
import { createAdmin } from "./admin.js";
import * as graph from "../builtin-modules/graph/index.js";
import * as astrometry from "../builtin-modules/astrometry/index.js";
import * as cas from "../builtin-modules/cas/index.js";
import * as flow from "../builtin-modules/flow/index.js";

export const BUILTIN_MODULES = [graph, astrometry, cas, flow];

// canvases: { ensure(imageId), create(options), save(entry, history) }
// adminKey: from admin.js; without it (and without storage) changes that
// need administrator approval are refused.
export async function createModuleHost({ storageDir = "", coreVersion, canvases, builtins = BUILTIN_MODULES, adminKey = "", allowUnsigned = false, trustedKeys = [], extraRuntimes = {}, transport = undefined, readSource = null } = {}) {
  const dir = storageDir ? join(storageDir, "modules") : "";
  const audit = createAudit(dir);
  const registry = createRegistry({ dir, coreVersion, builtins });
  await registry.load();
  const egress = createEgress({ audit, secrets: createSecrets({ dir }), ...(transport ? { transport } : {}) });
  const runtimes = { builtin: builtinRuntime, declarative: declarativeRuntime, wasm: wasmRuntime, http: createHttpRuntime({ egress }), ...extraRuntimes };
  const admin = createAdmin({ storageDir, key: adminKey, audit });
  let packages = null;
  const jobs = createJobs({ dir });
  await jobs.load();
  const host = { canvases, dir, audit, registry, runtimes, coreVersion, admin, egress, jobs };
  if (dir) {
    await ensureDirs(dir);
    packages = createPackages({ dir, registry, audit, runtimes, coreVersion, allowUnsigned, trustedKeys, reserved: new Set(builtins.map((b) => b.manifest.id)) });
    await packages.loadInstalled();
  }
  host.packages = packages;
  host.lifecycle = createLifecycle({ registry, audit, admin, actions: packages?.actions ?? {} });
  const derivedIndex = createDerivedIndex({ file: dir ? join(dir, "derived-index.json") : "" });
  await derivedIndex.load();
  host.derivedIndex = derivedIndex;
  host.derivedState = newDerivedState();
  // Optional hooks of built-in modules (#174-4): `init(context)` once, after the host exists; `health()` for /healthz under `healthKey`.
  // A hook that throws never stops the host or another module: init errors are logged to the audit, a failed health reads as unavailable.
  host.initBuiltins = async (context) => {
    for (const b of builtins) {
      if (typeof b.init !== "function") continue;
      try { await b.init(context); } catch (error) { audit.record({ kind: "builtin.init-failed", module: b.manifest.id, error: String(error?.message || error).slice(0, 300) }); }
    }
  };
  host.health = async () => {
    const out = {};
    for (const b of builtins) {
      if (typeof b.health !== "function" || typeof b.healthKey !== "string") continue;
      out[b.healthKey] = await Promise.resolve(b.health()).catch((error) => ({ available: false, reason: String(error?.message || error).slice(0, 200) }));
    }
    return out;
  };
  host.router = createRouter({ registry, audit, canvases, runtimes, jobs, egress, readSource, derivedIndex, models: () => host.models ?? null });
  return host;
}
