// Preload (node --import) for the power-loss simulator. It records what a
// power cut could NOT take back: every fsync of a file (its bytes at that
// moment) and every fsync of a directory (its entries at that moment), for
// paths under ESTAMPES_POWERLOSS_ROOT, appended synchronously to
// ESTAMPES_POWERLOSS_LOG before the real fsync returns to the caller.
// Anything not covered by a later record is treated as lost (see simulate.mjs).
import { open } from "node:fs/promises";
import { appendFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, fstatSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.env.ESTAMPES_POWERLOSS_ROOT, LOG = process.env.ESTAMPES_POWERLOSS_LOG;
if (ROOT && LOG) {
  const probe = await open(mkdtempSync(join(tmpdir(), "pl-")) + "/p", "w");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const record = (fd) => {
    let path;
    try { path = readlinkSync("/proc/self/fd/" + fd); } catch { return; }
    if (path !== ROOT && !path.startsWith(ROOT + "/")) return;
    const st = fstatSync(fd, { bigint: true }), id = String(st.ino) + ":" + String(st.birthtimeNs);
    if (st.isDirectory()) {
      const entries = readdirSync(path).map((name) => { const s = lstatSync(join(path, name), { bigint: true }); return [name, String(s.ino) + ":" + String(s.birthtimeNs), s.isDirectory() ? 1 : 0]; });
      appendFileSync(LOG, JSON.stringify({ t: "d", path, id, entries }) + "\n");
    } else if (st.isFile()) {
      if (path.endsWith(" (deleted)")) return;
      const data = readFileSync(path);
      appendFileSync(LOG, JSON.stringify({ t: "f", path, id, data: data.toString("base64") }) + "\n");
    }
  };
  for (const name of ["sync", "datasync"]) {
    const original = proto[name];
    proto[name] = async function (...args) { await original.apply(this, args); record(this.fd); };
  }
}
