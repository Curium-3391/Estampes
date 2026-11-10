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

// `records()`: the UVA record store when it is on (src/uva/record-store.js);
// notebooks are then read from and written to it, and no file is written here.
export function createNotebooks({ dir = "", records = () => null } = {}) {
  const books = new Map();
  const queues = new Map();
  const file = (id) => join(dir, id.replace(":", "_") + ".json");

  async function persist(nb) {
    if (records()) { await records().write("notebook", nb.id, nb); return; }
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    const path = file(nb.id), tmp = path + "." + process.pid + "." + Date.now() + ".tmp";
    await writeFile(tmp, JSON.stringify(nb));
    await rename(tmp, path);
  }

  async function load(id) {
    if (books.has(id)) return books.get(id);
    if (!(dir || records()) || !NOTEBOOK_ID.test(id)) return null;
    // A store that cannot be read throws, rather than passing for "no notebook".
    const read = records() ? () => records().read("notebook", id) : async () => { try { return JSON.parse(await readFile(file(id), "utf8")); } catch { return null; } };
    const nb = await read();
    if (nb?.schema !== NOTEBOOK_SCHEMA || nb.id !== id) return null;
    books.set(id, nb);
    return nb;
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
      if (records()) { for (const id of await records().list("notebook")) ids.add(id); }
      else if (dir) { try { for (const f of await readdir(dir)) { const m = /^nb_([0-9a-f]{12})\.json$/.exec(f); if (m) ids.add("nb:" + m[1]); } } catch {} }
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
    // For .estampes bundles. The export drops idempotency keys; the import
    // always makes a new notebook (nothing is overwritten) and trusts nothing
    // it reads: cells are rebuilt from known fields and every result comes
    // in stale, because a file cannot prove that SymPy computed it. Pressing
    // recompute re-derives each one from its input.
    exportOne(nb) {
      const { idem: _i, ...rest } = structuredClone(nb);
      return rest;
    },
    async importOne(raw) {
      const nb = cleanImported(raw);
      nb.id = newId("nb");
      books.set(nb.id, nb);
      await persist(nb);
      return nb;
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

// ---- import validation ------------------------------------------------------
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
const plainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const small = (v, max = 20000) => { try { return JSON.stringify(v).length <= max; } catch { return false; } };

function cleanImported(raw) {
  if (!plainObject(raw) || raw.schema !== NOTEBOOK_SCHEMA) throw new NotebookError("not a calculator notebook", "invalid");
  if (!small(raw, 4 * 1024 * 1024)) throw new NotebookError("the notebook is too large", "invalid");
  const now = new Date().toISOString();
  const nb = {
    schema: NOTEBOOK_SCHEMA, id: "", revision: 1, createdAt: now, updatedAt: now, title: str(raw.title, 80) ?? "",
    angle: raw.angle === "deg" ? "deg" : "rad", precision: Number.isInteger(raw.precision) && raw.precision >= 5 && raw.precision <= 100 ? raw.precision : 15,
    autoRefresh: raw.autoRefresh === true, definitions: {}, assumptions: {}, cells: [], idem: {},
  };
  const names = Object.entries(plainObject(raw.definitions) ? raw.definitions : {}).slice(0, 64);
  for (const [name, d] of names) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(name) || !plainObject(d) || !Array.isArray(d.params) || !small(d.body)) continue;
    nb.definitions[name] = { params: d.params.filter((x) => typeof x === "string" && /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(x)).slice(0, 8), text: str(d.text, 500) ?? "", body: d.body };
  }
  for (const [name, flags] of Object.entries(plainObject(raw.assumptions) ? raw.assumptions : {}).slice(0, 64)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(name) && Array.isArray(flags)) nb.assumptions[name] = flags.filter((f) => typeof f === "string" && /^[a-z_]{2,20}$/.test(f)).slice(0, 8);
  }
  const seen = new Set();
  for (const c of (Array.isArray(raw.cells) ? raw.cells : []).slice(0, MAX_CELLS)) {
    if (!plainObject(c) || !CELL_ID.test(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    const cell = { id: c.id, revision: Number.isInteger(c.revision) ? c.revision : 1, operation: str(c.operation, 40) ?? "evaluate",
      input: plainObject(c.input) && small(c.input, 8000) ? c.input : {}, params: plainObject(c.params) && small(c.params, 8000) ? c.params : {},
      angle: c.angle === "deg" ? "deg" : "rad", precision: Number.isInteger(c.precision) ? c.precision : 15, links: [] };
    if (plainObject(c.error) && small(c.error, 2000)) cell.error = { code: str(c.error.code, 40) ?? "internal", message: str(c.error.message, 300) ?? "" };
    else if (plainObject(c.result) && small(c.result, 200000)) {
      cell.result = c.result;
      cell.stale = true; cell.staleReason = "imported from a bundle; recompute to verify it";
    }
    for (const l of (Array.isArray(c.links) ? c.links : []).slice(0, 50)) {
      if (!plainObject(l) || typeof l.canvas !== "string" || typeof l.object !== "string") continue;
      cell.links.push({ canvas: l.canvas.slice(0, 80), object: l.object.slice(0, 64), resultId: str(l.resultId, 40), expression: str(l.expression, 300), ...(Array.isArray(l.domain) && l.domain.length === 2 && l.domain.every(Number.isFinite) ? { domain: l.domain } : {}), status: "stale", at: str(l.at, 40) ?? now });
    }
    nb.cells.push(cell);
  }
  return nb;
}
