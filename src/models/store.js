// #85 V1-2: instances of module-owned data (the `models[]` types of a module/2 manifest).
//
// An instance is one UVA record of kind `model` (src/uva/record-store.js), independent of any canvas or view: id `md:<12 hex>`,
// owned by one module, of one declared type, at one `revision`. The store adds no storage of its own. What it adds is the contract
// around the record:
//   * a write names the revision it was made against (`expectedRevision`); a change over several instances checks every one of them
//     first and then writes them together with the record store's writeMany, so any conflict fails the whole change and nothing is written;
//   * an undo is a new change with the same precondition: it restores what the command replaced only while that command is still the
//     instance's latest, and reports a conflict otherwise (nothing is overwritten, no merging);
//   * a command id that was already applied answers with its earlier result and changes nothing.
//
// Assumption, enforced: one store per record store, in one server process. Revision checks happen under per-instance locks taken in
// id order (so two changes over the same instances in opposite order cannot wait on each other); a second writer to the same records
// could not be seen by those locks, so a second store over the same records is refused.
//
// The history (the last few commands per instance, with the value each replaced) is bounded by size, so a record stays far below the
// UVA document limit. A command id older than that history is no longer recognised.
import { createHash, randomBytes } from "node:crypto";
import { validateValue } from "../modules/json-schema.js";

export const MODEL_SCHEMA = "estampes.model/1";
const HISTORY_BYTES = 256 * 1024, HISTORY_MAX = 20;
const DEFAULT_TOTAL = 128;

export class ModelError extends Error {
  constructor(message, code, details) { super(message); this.name = "ModelError"; this.code = code; if (details) this.details = details; }
}
const clone = (v) => JSON.parse(JSON.stringify(v));
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const sigOf = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

const stores = new WeakMap();

// records: the record store (read / writeMany / list). total: most instances over all modules (the UVA store shares one document
// limit with canvases, workspaces and notebooks, so models may not use it all). now: a clock for display times only.
export function createModelStore({ records, total = DEFAULT_TOTAL, now = () => new Date().toISOString() }) {
  if (!records) throw new Error("a model store needs the record store");
  if (stores.has(records)) throw new ModelError("a model store already exists over these records; a second writer would not see its locks", "single-writer");
  const locks = new Map();
  stores.set(records, true);

  // Runs fn while holding the locks of ids, taken in sorted order.
  async function withLocks(ids, fn) {
    const sorted = [...new Set(ids)].sort(), releases = [];
    try {
      for (const id of sorted) {
        const before = locks.get(id) ?? Promise.resolve();
        let release; const mine = new Promise((r) => { release = r; });
        const chained = before.then(() => mine);
        locks.set(id, chained);
        await before;
        releases.push(() => { release(); if (locks.get(id) === chained) locks.delete(id); });
      }
      return await fn();
    } finally { for (const r of releases.reverse()) r(); }
  }

  const fresh = async () => {
    for (let i = 0; i < 20; i++) {
      const id = "md:" + randomBytes(6).toString("hex");
      if (!(await records.read("model", id))) return id;
    }
    throw new ModelError("could not allocate an instance id", "internal");
  };

  // A record this module may open: its own, and of a version it declares it can read. Anything else is left exactly as it is.
  function open(record, type, module) {
    if (!record) throw new ModelError("no model instance", "not-found");
    if (record.owner.module !== module) throw new ModelError("that instance belongs to another module", "forbidden");
    if (record.type.model !== type.id) throw new ModelError("that instance is a " + record.type.model + ", not a " + type.id, "wrong-type");
    const readable = new Set([type.dataVersion, ...(type.readsVersions ?? [])]);
    if (!readable.has(record.type.dataVersion)) {
      throw new ModelError("the instance is data version " + record.type.dataVersion + "; this module reads " + [...readable].sort().join(", ") + ". It is kept as it is", "incompatible", { dataVersion: record.type.dataVersion });
    }
    return record;
  }
  const checkValue = (type, value) => {
    let out;
    try { out = validateValue(type.schema, value, "value"); } catch (error) { throw new ModelError(error.message, "schema"); }
    if (bytes(out) > (type.maxBytes ?? 16384)) throw new ModelError("the value is larger than the type's maxBytes (" + (type.maxBytes ?? 16384) + ")", "limit");
    return out;
  };
  const trim = (history, type) => {
    const room = Math.max(1, Math.min(HISTORY_MAX, Math.floor(HISTORY_BYTES / Math.max(1, type.maxBytes ?? 16384))));
    return history.slice(-room);
  };
  const view = (r) => ({ id: r.id, module: r.owner.module, model: r.type.model, dataVersion: r.type.dataVersion, revision: r.revision, value: clone(r.value), updatedAt: r.updatedAt });

  const api = {
    // type: the manifest's model type of `module`. Returns the new instance.
    async create({ module, type, value, commandId, by = "assistant" }) {
      const checked = checkValue(type, value);
      const existing = await api.list({ module, model: type.id, raw: true });
      // The same command id again: the instance it made, not another one.
      const again = commandId ? existing.find((r) => r.history[0]?.commandId === commandId && r.history[0].kind === "create") : null;
      if (again) {
        if (again.history[0].sig !== sigOf(checked)) throw new ModelError("the command id " + commandId + " was used for a different change", "duplicate-command");
        return view(again);
      }
      if (existing.length >= (type.maxInstances ?? 32)) throw new ModelError(module + " already has " + existing.length + " " + type.id + " instances (the type allows " + (type.maxInstances ?? 32) + ")", "limit");
      if ((await records.list("model")).length >= total) throw new ModelError("the store holds the most model instances it allows (" + total + ")", "limit");
      const id = await fresh(), at = now();
      const record = { schema: MODEL_SCHEMA, id, owner: { module }, type: { model: type.id, dataVersion: type.dataVersion }, revision: 1, createdAt: at, updatedAt: at, value: checked,
        history: [{ revision: 1, commandId: commandId ?? null, by, at, kind: "create", sig: sigOf(checked) }] };
      await records.writeMany([{ kind: "model", id, value: record, line: { kind: "create", commandId: commandId ?? null } }]);
      return view(record);
    },

    // #85 V3-B: puts an instance from a bundle on this server under the id it had (derived objects name it as their source). Never
    // overwrites: an id that is already here is left exactly as it is and reported. The value is checked against the module's type now;
    // history starts again at revision 1 (a bundle does not carry history).
    async restore({ module, type, id, value }) {
      if (typeof id !== "string" || !/^md:[0-9a-f]{12}$/.test(id)) throw new ModelError("not an instance id", "invalid");
      const have = await records.read("model", id);
      if (have) return { status: "exists", same: have.owner.module === module && have.type.model === type.id && sigOf(have.value) === sigOf(value) };
      const checked = checkValue(type, value);
      const existing = await api.list({ module, model: type.id, raw: true });
      if (existing.length >= (type.maxInstances ?? 32)) throw new ModelError(module + " already has " + existing.length + " " + type.id + " instances (the type allows " + (type.maxInstances ?? 32) + ")", "limit");
      if ((await records.list("model")).length >= total) throw new ModelError("the store holds the most model instances it allows (" + total + ")", "limit");
      const at = now();
      const record = { schema: MODEL_SCHEMA, id, owner: { module }, type: { model: type.id, dataVersion: type.dataVersion }, revision: 1, createdAt: at, updatedAt: at, value: checked,
        history: [{ revision: 1, commandId: "import:" + id, by: "import", at, kind: "create", sig: sigOf(checked) }] };
      await records.writeMany([{ kind: "model", id, value: record, line: { kind: "create", commandId: "import:" + id } }]);
      return { status: "restored", instance: view(record) };
    },

    // One instance as a bundle carries it (owner, type, revision, value; no history), or null. Needs no module to be loaded.
    async peek(id) {
      const r = typeof id === "string" ? await records.read("model", id) : null;
      return r ? { id: r.id, module: r.owner.module, model: r.type.model, dataVersion: r.type.dataVersion, revision: r.revision, value: clone(r.value) } : null;
    },

    async read({ module, type, id }) { return view(open(await records.read("model", id), type, module)); },

    // Instances of one module (and type). Values are not included.
    async list({ module, model, raw = false }) {
      const out = [];
      for (const id of await records.list("model")) {
        const r = await records.read("model", id);
        if (r && r.owner.module === module && (model === undefined || r.type.model === model)) out.push(raw ? r : { id: r.id, model: r.type.model, dataVersion: r.type.dataVersion, revision: r.revision, updatedAt: r.updatedAt });
      }
      return out;
    },

    // Every instance of every module, without values, for the surface state (bounded by `limit`).
    async index({ limit = 100 } = {}) {
      const out = [];
      for (const id of await records.list("model")) {
        if (out.length >= limit) break;
        const r = await records.read("model", id);
        if (r) out.push({ id: r.id, module: r.owner.module, model: r.type.model, dataVersion: r.type.dataVersion, revision: r.revision, bytes: bytes(r.value), updatedAt: r.updatedAt });
      }
      return out;
    },

    // One change over one or more instances. changes: [{ id, type, expectedRevision, value }]. All or nothing.
    async commit({ module, commandId, by = "assistant", changes }) {
      if (!commandId) throw new ModelError("a change needs a command id", "input");
      if (!changes?.length) throw new ModelError("nothing to change", "input");
      const ids = changes.map((c) => c.id);
      if (new Set(ids).size !== ids.length) throw new ModelError("an instance appears twice in one change", "input");
      return withLocks(ids, async () => {
        const current = [];
        for (const c of changes) current.push(open(await records.read("model", c.id), c.type, module));
        // A command id already applied to these instances: the earlier answer, nothing written.
        const applied = current.map((r) => r.history.find((h) => h.commandId === commandId && h.kind === "write"));
        if (applied.some(Boolean)) {
          const same = applied.every(Boolean) && applied.every((h, i) => h.sig === sigOf(changes[i].value));
          if (!same) throw new ModelError("the command id " + commandId + " was used for a different change", "duplicate-command");
          return { status: "already-applied", instances: current.map(view) };
        }
        // Every precondition is checked before anything is written.
        const stale = changes.filter((c, i) => c.expectedRevision !== current[i].revision).map((c) => ({ id: c.id, expectedRevision: c.expectedRevision, revision: current.find((r) => r.id === c.id).revision }));
        if (stale.length) throw new ModelError("changed since revision " + stale.map((s) => s.id + "@" + s.expectedRevision).join(", ") + "; read it again and retry", "conflict", { stale });
        const at = now();
        const entries = changes.map((c, i) => {
          const r = current[i], value = checkValue(c.type, c.value);
          const next = { ...r, type: { ...r.type, dataVersion: c.type.dataVersion }, revision: r.revision + 1, updatedAt: at, value,
            history: trim([...r.history, { revision: r.revision + 1, commandId, by, at, kind: "write", sig: sigOf(c.value), before: r.value }], c.type) };
          return { kind: "model", id: r.id, value: next, line: { kind: "write", commandId, revision: next.revision } };
        });
        await records.writeMany(entries);
        return { status: "applied", instances: entries.map((e) => view(e.value)) };
      });
    },

    // Undo what `commandId` wrote: only while it is still the latest change of every instance it touched. A new change with its own
    // command id and the revision it checked; if anyone changed an instance since, it is a conflict and nothing is written.
    async undo({ module, types, commandId, undoCommandId, by = "assistant" }) {
      if (!undoCommandId) throw new ModelError("an undo needs its own command id", "input");
      const ids = [];
      for (const id of await records.list("model")) { const r = await records.read("model", id); if (r?.owner.module === module && r.history.some((h) => h.commandId === commandId)) ids.push(id); }
      if (!ids.length) throw new ModelError("no instance of " + module + " has a change with command id " + commandId + " in its history", "not-found");
      return withLocks(ids, async () => {
        const current = [];
        for (const id of ids) { const r = await records.read("model", id); current.push(open(r, types[r.type.model] ?? (() => { throw new ModelError("no model type " + r.type.model, "wrong-type"); })(), module)); }
        if (current.every((r) => r.history.some((h) => h.commandId === undoCommandId && h.kind === "undo"))) return { status: "already-applied", instances: current.map(view) };
        const stale = [];
        for (const r of current) {
          const mine = r.history.find((h) => h.commandId === commandId);
          if (mine.kind !== "write") throw new ModelError("a creation cannot be undone yet", "unsupported");
          if (mine.revision !== r.revision) stale.push({ id: r.id, undoes: mine.revision, revision: r.revision });
        }
        if (stale.length) throw new ModelError("changed after that command; it cannot be undone without overwriting later changes", "conflict", { stale });
        const at = now();
        const entries = current.map((r) => {
          const mine = r.history.find((h) => h.commandId === commandId);
          const type = types[r.type.model];
          const next = { ...r, revision: r.revision + 1, updatedAt: at, value: clone(mine.before), history: trim([...r.history, { revision: r.revision + 1, commandId: undoCommandId, by, at, kind: "undo", of: commandId, before: r.value }], type) };
          return { kind: "model", id: r.id, value: next, line: { kind: "undo", commandId: undoCommandId, of: commandId, revision: next.revision } };
        });
        await records.writeMany(entries);
        return { status: "applied", instances: entries.map((e) => view(e.value)) };
      });
    },
  };
  return api;
}
