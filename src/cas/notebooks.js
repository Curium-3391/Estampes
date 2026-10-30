// CAS notebooks: editable cells, definitions and assumptions, plus the
// links from a result to the Graph objects drawn from it. They live in the
// shared server store (<storage>/cas/notebooks), never in the browser, so a
// reloaded widget, a restart or the model all see the same state. Writes are
// atomic and revision-checked; a stale writer gets a "conflict" error.
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const NOTEBOOK_SCHEMA = "estampes.cas-notebook/1";
export const MAX_CELLS = 200;
export const NOTEBOOK_ID = /^nb:[0-9a-f]{12}$/;
export const CELL_ID = /^cell:[0-9a-f]{12}$/;
const newId = (p) => p + ":" + randomBytes(6).toString("hex");

export class NotebookError extends Error {
  constructor(message, code = "invalid") { super(message); this.code = code; }
}

export function createNotebooks({ dir = "" } = {}) {
  const books = new Map();
  const queues = new Map();
  const file = (id) => join(dir, id.replace(":", "_") + ".json");

  async function persist(nb) {
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    const path = file(nb.id), tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
    await writeFile(tmp, JSON.stringify(nb));
    await rename(tmp, path);
  }

  async function load(id) {
    if (books.has(id)) return books.get(id);
    if (!dir || !NOTEBOOK_ID.test(id)) return null;
    try {
      const nb = JSON.parse(await readFile(file(id), "utf8"));
      if (nb?.schema !== NOTEBOOK_SCHEMA || nb.id !== id) return null;
      books.set(id, nb);
      return nb;
    } catch { return null; }
  }

  const api = {
    async create({ angle = "rad", precision = 15, title } = {}) {
      const nb = { schema: NOTEBOOK_SCHEMA, id: newId("nb"), revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        title: title?.slice(0, 80) ?? "", angle, precision, definitions: {}, assumptions: {}, cells: [], idem: {} };
      books.set(nb.id, nb);
      await persist(nb);
      return nb;
    },
    async get(id) {
      const nb = await load(id);
      if (!nb) throw new NotebookError("no notebook " + JSON.stringify(id), "not-found");
      return nb;
    },
    async list() {
      const ids = new Set(books.keys());
      if (dir) { try { for (const f of await readdir(dir)) { const m = /^nb_([0-9a-f]{12})\.json$/.exec(f); if (m) ids.add("nb:" + m[1]); } } catch {} }
      const out = [];
      for (const id of ids) { const nb = await load(id); if (nb) out.push(nb); }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    // Serialised read-modify-write. fn gets the notebook, changes it in
    // place and returns a value; the revision goes up by one and the file
    // is rewritten only when fn did not throw.
    async mutate(id, { expectedRevision } = {}, fn) {
      const prev = queues.get(id) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(async () => {
        const nb = await api.get(id);
        if (expectedRevision !== undefined && expectedRevision !== nb.revision) {
          throw new NotebookError("the notebook changed since revision " + expectedRevision + " (now " + nb.revision + "); read it again and retry", "conflict");
        }
        const draft = structuredClone(nb);
        const value = await fn(draft);
        draft.revision = nb.revision + 1;
        draft.updatedAt = new Date().toISOString();
        books.set(id, draft);
        try { await persist(draft); } catch (error) { books.set(id, nb); throw error; }
        return value;
      });
      queues.set(id, run);
      return run;
    },
    newCellId: () => newId("cell"),
    newResultId: () => newId("cr"),
    // A bounded summary for tools and the model.
    summary(nb, { cells = 30, full = false } = {}) {
      const shown = nb.cells.slice(-cells);
      return {
        notebookId: nb.id, revision: nb.revision, title: nb.title, angle: nb.angle, precision: nb.precision,
        definitions: Object.entries(nb.definitions).map(([name, d]) => ({ name, params: d.params, text: d.text })),
        assumptions: nb.assumptions, autoRefresh: !!nb.autoRefresh,
        cellCount: nb.cells.length, truncated: nb.cells.length > shown.length,
        cells: shown.map((c) => cellSummary(c, full)),
      };
    },
  };
  return api;
}

export function cellSummary(c, full = false) {
  const r = c.result;
  return {
    cellId: c.id, revision: c.revision, operation: c.operation, input: c.input, params: c.params,
    state: c.error ? "error" : c.stale ? "stale" : r ? "fresh" : "empty",
    ...(c.staleReason ? { staleReason: c.staleReason } : {}),
    ...(c.error ? { error: c.error } : {}),
    ...(r ? { result: { resultId: r.resultId, status: r.status, plain: r.display?.plain ?? r.exact?.plain, latex: r.display?.latex ?? r.exact?.latex,
      ...(r.approx ? { approx: r.approx.plain } : {}), warnings: r.warnings, engine: r.engine, computedAt: r.computedAt, author: r.author,
      ...(full ? { ast: r.exact?.ast, items: r.items } : {}) } } : {}),
    links: (c.links ?? []).map((l) => ({ ...l })),
  };
}
