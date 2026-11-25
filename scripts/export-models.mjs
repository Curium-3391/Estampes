// Takes module model instances (#85) out of the UVA store as JSON, without running or loading any module. Run it with the server stopped:
//   node scripts/export-models.mjs <storage dir> [<uva dir>] [<profile>] [--module <id>] [--out <file>]
// Read-only: no commit is made and nothing in the store changes. It reads what the record store holds (the higher seq of the committed
// document and its durable pending copy, the same choice the server makes). The output is estampes.model-export/1: each instance's owner,
// type, revision and current value, no history. Workspace bundles do not carry models yet; this is the way to take them out.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createUvaService } from "../src/uva/service.js";
import { createRecordStore } from "../src/uva/record-store.js";
import { exportModels } from "../src/models/export.js";

const args = process.argv.slice(2), flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, v] = args.splice(i, 2); return v; };
const module = flag("--module"), out = flag("--out");
const [storageArg, uvaArg, profileArg] = args;
if (!storageArg) { console.error("Usage: node scripts/export-models.mjs <storage dir> [<uva dir>] [<profile>] [--module <id>] [--out <file>]"); process.exit(2); }
const storageDir = resolve(storageArg), uvaDir = resolve(uvaArg ?? storageDir.replace(/\/+$/, "") + "-uva");
const service = await createUvaService({ enabled: true, canvasStore: true, directory: uvaDir, profile: profileArg ?? "linux-process-crash-test", legacyDirectory: storageDir });
const records = await createRecordStore({ service, storageDir, idleMs: 3600000, retryEveryMs: 0 });
try {
  const result = await exportModels({ records, module: module ?? null });
  const text = JSON.stringify(result, null, 2) + "\n";
  if (out) { await writeFile(resolve(out), text); console.error("wrote " + result.count + " instance(s) to " + resolve(out)); } else process.stdout.write(text);
} finally { await records.close?.(); await service.close?.(); }
