// Structured log of module administration (plans, approvals, installs,
// failures) and of module runs. One JSON object per line in
// <storage>/modules/audit.jsonl, plus the latest entries in memory for the
// Store's activity tab. Secrets and admin codes never reach this log.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MEMORY = 300;

export function createAudit(dir) {
  const recent = [];
  let ready = null;
  const file = dir ? join(dir, "audit.jsonl") : null;
  async function append(line) {
    if (!file) return;
    ready ??= mkdir(dir, { recursive: true });
    await ready;
    await appendFile(file, line);
  }
  let chain = Promise.resolve();
  return {
    record(event) {
      const entry = { at: new Date().toISOString(), ...event };
      recent.push(entry);
      if (recent.length > MEMORY) recent.splice(0, recent.length - MEMORY);
      chain = chain.then(() => append(JSON.stringify(entry) + "\n")).catch(() => {});
      return entry;
    },
    // Newest first. filter: { module, kinds: [...] }
    recent(limit = 50, { module, kinds } = {}) {
      return recent.filter((e) => (!module || e.module === module) && (!kinds || kinds.includes(e.kind))).slice(-limit).reverse();
    },
    // From disk, for the CLI and after a restart.
    async read(limit = 200) {
      if (!file) return this.recent(limit);
      // Lines recorded before this call are still being appended: wait for them.
      await chain;
      try {
        const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).slice(-limit);
        return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
      } catch { return []; }
    },
    flush: () => chain,
  };
}
