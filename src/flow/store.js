// #86 F1-4: Flows kept as UVA records (kind `flow`, id `fl:<12 hex>`), so a flow gets the same durability, revisions and recovery as every other
// document and no storage of its own. The record holds the graph (`estampes.flow/1`, revision-checked and undoable), the results of the last runs
// (written by whoever ran the flow; they are not a change of the graph and do not bump its revision) and a bounded history of graph changes.
//
// The store checks the graph's shape and size, not whether its modules exist or its types fit: a graph is built up in steps and a module may be
// removed later, so an incomplete or currently unrunnable graph is stored as it is and `validateFlow` says what is wrong when it is read or run.
import { randomBytes } from "node:crypto";
import { checkShape, FLOW_SCHEMA } from "./graph.js";
import { emptyState } from "./run.js";
import { clone, bytes, sigOf, trimHistory, claimStore, createLocks, staleOf } from "../records/revisioned.js";

export const FLOW_RECORD_SCHEMA = "estampes.flow-record/1";
export const FLOW_LIMITS = { total: 32, flowBytes: 65536, resultBytes: 262144, nameChars: 80 };

export class FlowError extends Error {
  constructor(message, code, details) { super(message); this.name = "FlowError"; this.code = code; if (details) this.details = details; }
}

export const emptyFlow = () => ({ schema: FLOW_SCHEMA, nodes: [], edges: [] });

export function createFlowStore({ records, total = FLOW_LIMITS.total, now = () => new Date().toISOString() }) {
  if (!records) throw new Error("a flow store needs the record store");
  const refused = claimStore(records, "flow");
  if (refused) throw new FlowError(refused, "single-writer");
  const withLocks = createLocks();

  const fresh = async () => {
    for (let i = 0; i < 20; i++) {
      const id = "fl:" + randomBytes(6).toString("hex");
      if (!(await records.read("flow", id))) return id;
    }
    throw new FlowError("could not allocate a flow id", "internal");
  };
  const checkGraph = (flow) => {
    const errors = checkShape(flow);
    if (errors.length) throw new FlowError("the flow is not well formed: " + errors.slice(0, 3).map((e) => e.path + " " + e.message).join("; "), "shape", { errors: errors.slice(0, 20) });
    if (bytes(flow) > FLOW_LIMITS.flowBytes) throw new FlowError("the flow is larger than " + FLOW_LIMITS.flowBytes + " bytes", "limit");
    return clone(flow);
  };
  const checkName = (name) => {
    if (typeof name !== "string" || !name.trim() || name.length > FLOW_LIMITS.nameChars) throw new FlowError("a flow needs a name of 1 to " + FLOW_LIMITS.nameChars + " characters", "input");
    return name.trim();
  };
  const need = (r) => { if (!r) throw new FlowError("no such flow", "not-found"); return r; };
  const view = (r) => ({ id: r.id, name: r.name, revision: r.revision, flow: clone(r.flow), results: clone(r.results), updatedAt: r.updatedAt });
  const idOk = (id) => typeof id === "string" && /^fl:[0-9a-f]{12}$/.test(id);
  const read = async (id) => need(idOk(id) ? await records.read("flow", id) : null);

  return {
    async create({ name, flow = emptyFlow(), commandId, by = "assistant" }) {
      const nm = checkName(name), graph = checkGraph(flow);
      return withLocks(["create"], async () => {
        const ids = await records.list("flow");
        // The same command id again: the flow it made, not another one.
        if (commandId) for (const id of ids) {
          const r = await records.read("flow", id), h = r?.history[0];
          if (h?.commandId === commandId && h.kind === "create") {
            if (h.sig !== sigOf({ name: nm, flow: graph })) throw new FlowError("the command id " + commandId + " was used for a different change", "duplicate-command");
            return view(r);
          }
        }
        if (ids.length >= total) throw new FlowError("the store holds the most flows it allows (" + total + ")", "limit");
        const id = await fresh(), at = now();
        const record = { schema: FLOW_RECORD_SCHEMA, id, name: nm, revision: 1, createdAt: at, updatedAt: at, flow: graph, results: emptyState(),
          history: [{ revision: 1, commandId: commandId ?? null, by, at, kind: "create", sig: sigOf({ name: nm, flow: graph }) }] };
        await records.writeMany([{ kind: "flow", id, value: record, line: { kind: "create", commandId: commandId ?? null } }]);
        return view(record);
      });
    },

    async read(id) { return view(await read(id)); },

    // Every flow, without graphs.
    async list() {
      const out = [];
      for (const id of await records.list("flow")) {
        const r = await records.read("flow", id);
        if (r) out.push({ id: r.id, name: r.name, revision: r.revision, nodes: r.flow.nodes.length, edges: r.flow.edges.length, updatedAt: r.updatedAt });
      }
      return out;
    },

    // The earlier answer when `commandId` already changed this flow (`request` is what it asked for, compared with what it asked for then), else null.
    async applied({ id, commandId, request }) {
      const r = await read(id), done = r.history.find((h) => h.commandId === commandId && h.kind === "write");
      if (!done) return null;
      if (done.sig !== sigOf(request)) throw new FlowError("the command id " + commandId + " was used for a different change", "duplicate-command");
      return view(r);
    },

    // Replaces the graph (expectedRevision is the revision the new graph was made from). `request` is what the caller asked for (its operations),
    // kept as the change's signature so a retry of the same call is recognised even though the graph is no longer what it started from.
    async edit({ id, commandId, expectedRevision, flow, request = flow, by = "assistant" }) {
      if (!commandId) throw new FlowError("a change needs a command id", "input");
      const graph = checkGraph(flow);
      return withLocks([id], async () => {
        const r = await read(id), done = r.history.find((h) => h.commandId === commandId && h.kind === "write");
        if (done) {
          if (done.sig !== sigOf(request)) throw new FlowError("the command id " + commandId + " was used for a different change", "duplicate-command");
          return { status: "already-applied", flow: view(r) };
        }
        const stale = staleOf([{ id, expectedRevision }], [r]);
        if (stale.length) throw new FlowError("changed since revision " + expectedRevision + " (now " + r.revision + "); read it again and retry", "conflict", { stale });
        const at = now();
        const next = { ...r, revision: r.revision + 1, updatedAt: at, flow: graph,
          history: trimHistory([...r.history, { revision: r.revision + 1, commandId, by, at, kind: "write", sig: sigOf(request), before: r.flow }], bytes(graph)) };
        await records.writeMany([{ kind: "flow", id, value: next, line: { kind: "write", commandId, revision: next.revision } }]);
        return { status: "applied", flow: view(next) };
      });
    },

    // Undoes what `commandId` wrote, only while it is still the latest change; otherwise a conflict and nothing is written.
    async undo({ id, commandId, undoCommandId, by = "assistant" }) {
      if (!undoCommandId) throw new FlowError("an undo needs its own command id", "input");
      return withLocks([id], async () => {
        const r = await read(id), mine = r.history.find((h) => h.commandId === commandId);
        if (!mine) throw new FlowError("no change with command id " + commandId + " in this flow's history", "not-found");
        if (r.history.some((h) => h.commandId === undoCommandId && h.kind === "undo")) return { status: "already-applied", flow: view(r) };
        if (mine.kind !== "write") throw new FlowError("a creation cannot be undone", "unsupported");
        if (mine.revision !== r.revision) throw new FlowError("changed after that command; it cannot be undone without overwriting later changes", "conflict", { stale: [{ id, undoes: mine.revision, revision: r.revision }] });
        const at = now(), back = clone(mine.before);
        const next = { ...r, revision: r.revision + 1, updatedAt: at, flow: back,
          history: trimHistory([...r.history, { revision: r.revision + 1, commandId: undoCommandId, by, at, kind: "undo", of: commandId, before: r.flow }], bytes(back)) };
        await records.writeMany([{ kind: "flow", id, value: next, line: { kind: "undo", commandId: undoCommandId, of: commandId, revision: next.revision } }]);
        return { status: "applied", flow: view(next) };
      });
    },

    // Keeps the results of a run, only if the graph is still the revision the run was made from (results of an older graph are dropped, not
    // mixed in). Does not change the graph's revision.
    async saveResults({ id, revision, results }) {
      if (bytes(results) > FLOW_LIMITS.resultBytes) throw new FlowError("the results are larger than " + FLOW_LIMITS.resultBytes + " bytes and were not kept", "limit");
      return withLocks([id], async () => {
        const r = await read(id);
        if (r.revision !== revision) return { status: "outdated", revision: r.revision };
        const next = { ...r, results: clone(results), resultsAt: now() };
        await records.writeMany([{ kind: "flow", id, value: next, line: { kind: "results", revision: r.revision } }]);
        return { status: "saved", revision: r.revision };
      });
    },
  };
}
