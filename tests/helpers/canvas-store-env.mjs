// Runs the existing tests with ESTAMPES_CANVAS_STORE=uva:
//   ESTAMPES_TEST_CANVAS_STORE=uva NODE_OPTIONS="--import $PWD/tests/helpers/canvas-store-env.mjs" npm test
// (an absolute path: some tests start node in other folders)
// Every server.js a test starts gets its own fresh UVA folder, unless the
// test configures UVA itself. Test-only; nothing here runs in production.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.ESTAMPES_TEST_CANVAS_STORE === "uva" && /server\.js$/.test(process.argv[1] ?? "") && !process.env.ESTAMPES_UVA_BETA_DIR && process.env.ESTAMPES_STORAGE_DIR) {
  Object.assign(process.env, { ESTAMPES_UVA_BETA_DIR: mkdtempSync(join(tmpdir(), "estampes-test-uva-")),
    ESTAMPES_UVA_BETA_PROFILE: "linux-process-crash-test", ESTAMPES_CANVAS_STORE: "uva", ESTAMPES_UVA_MIRROR_IDLE_SEC: "0" });
}
