// The module host: registry + lifecycle + router + audit, wired to the
// canvas store. server.js creates one; tests create their own with a
// temporary folder. Module data lives in <storage>/modules/ (or memory).
import { join } from "node:path";
import { createAudit } from "./audit.js";
import { createRegistry } from "./registry.js";
import { createLifecycle } from "./lifecycle.js";
import { createRouter } from "./router.js";
import { builtinRuntime } from "./runtimes/builtin.js";
import { declarativeRuntime } from "./runtimes/declarative.js";
import { wasmRuntime } from "./runtimes/wasm.js";
import { createPackages, ensureDirs } from "./packages.js";
import { createAdmin } from "./admin.js";
import * as graph from "../builtin-modules/graph/index.js";

export const BUILTIN_MODULES = [graph];

// canvases: { ensure(imageId), create(options), save(entry, history) }
// adminKey: from admin.js; without it (and without storage) changes that
// need administrator approval are refused.
export async function createModuleHost({ storageDir = "", coreVersion, canvases, builtins = BUILTIN_MODULES, adminKey = "", allowUnsigned = false, trustedKeys = [], extraRuntimes = {} } = {}) {
  const dir = storageDir ? join(storageDir, "modules") : "";
  const audit = createAudit(dir);
  const registry = createRegistry({ dir, coreVersion, builtins });
  await registry.load();
  const runtimes = { builtin: builtinRuntime, declarative: declarativeRuntime, wasm: wasmRuntime, ...extraRuntimes };
  const admin = createAdmin({ storageDir, key: adminKey, audit });
  let packages = null;
  const host = { dir, audit, registry, runtimes, coreVersion, admin };
  if (dir) {
    await ensureDirs(dir);
    packages = createPackages({ dir, registry, audit, runtimes, coreVersion, allowUnsigned, trustedKeys, reserved: new Set(builtins.map((b) => b.manifest.id)) });
    await packages.loadInstalled();
  }
  host.packages = packages;
  host.lifecycle = createLifecycle({ registry, audit, admin, actions: packages?.actions ?? {} });
  host.router = createRouter({ registry, audit, canvases, runtimes });
  return host;
}
