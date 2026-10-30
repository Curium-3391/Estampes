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
import * as graph from "../builtin-modules/graph/index.js";

export const BUILTIN_MODULES = [graph];

// canvases: { ensure(imageId), create(options), save(entry, history) }
export async function createModuleHost({ storageDir = "", coreVersion, canvases, builtins = BUILTIN_MODULES, admin = null, extraRuntimes = {}, extraActions = {} } = {}) {
  const dir = storageDir ? join(storageDir, "modules") : "";
  const audit = createAudit(dir);
  const registry = createRegistry({ dir, coreVersion, builtins });
  await registry.load();
  const runtimes = { builtin: builtinRuntime, declarative: declarativeRuntime, ...extraRuntimes };
  const lifecycle = createLifecycle({ registry, audit, admin, actions: extraActions });
  const router = createRouter({ registry, audit, canvases, runtimes });
  return { dir, audit, registry, lifecycle, router, runtimes, coreVersion, admin };
}
