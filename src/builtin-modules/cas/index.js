// Scientific CAS: SymPy, run by the separate cas-service. This module only
// builds typed requests, keeps the notebook and turns plottable results into
// Graph operations; it never evaluates anything itself. Computation, the
// closed expression parser and all limits live in cas-service/.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as graph from "../graph/index.js";
import { CasClientError } from "../../cas/client.js";
import { cellSummary } from "../../cas/notebooks.js";
import { BridgeError, checkPlottable } from "../../cas/bridge.js";
import { FUNCTIONS } from "../../scene/expression.js";
import { canvasObjects } from "../../scene/scene-ops.js";

export const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

// server.js (or a test) supplies { client, notebooks } once at start-up.
let deps = { client: null, notebooks: null };
export const notebookStore = () => deps.notebooks;
export const configure = (next) => { deps = { ...deps, ...next }; };
export const casStatus = async () => {
  if (!deps.client) return { available: false, reason: "no calculator service is configured (ESTAMPES_CAS_SOCKET)" };
  try { const h = await deps.client.health(); return { available: true, engine: h.engine, operations: h.operations, limits: h.limits }; }
  catch (error) { return { available: false, reason: error.message }; }
};

const RESERVED_NAMES = new Set(["pi", "e", "E", "I", "oo", "inf", "infinity", "nan", "x_", ...Object.keys(FUNCTIONS), "deg", "rad", "matrix", "Matrix", "factorial", "gamma", "root", "binomial", "gcd", "lcm"]);
const needBackend = () => {
  if (!deps.client || !deps.notebooks) throw new Error("the calculator service is not configured on this server (set ESTAMPES_CAS_SOCKET; with Docker Compose it is on by default)");
};
const userError = (e) => ({ code: e instanceof CasClientError ? e.code : e.code ?? "internal", message: String(e.message).slice(0, 300) });

function envOf(nb) {
  const definitions = {};
  for (const [name, d] of Object.entries(nb.definitions)) definitions[name] = { params: d.params, body: d.body };
  return { definitions, assumptions: nb.assumptions };
}

function requestOf(nb, p) {
  const input = {};
  if (p.latex !== undefined) input.latex = p.latex; else if (p.text !== undefined) input.text = p.text;
  if (p.equations) input.equations = p.equations;
  const params = {};
  for (const k of ["variable", "variables", "order", "lower", "upper", "point", "direction", "n", "guess", "domain", "mode", "other"]) if (p[k] !== undefined) params[k] = p[k];
  if (p.subs) params.subs = Object.fromEntries(p.subs.map((s) => [s.name, s.value]));
  return { operation: p.operation, input, params, env: envOf(nb), angle: p.angle ?? nb.angle, precision: p.precision ?? nb.precision, timeoutMs: 8000 };
}

async function compute(nb, p) {
  try { return { result: await deps.client.compute(requestOf(nb, p), p.job ? { id: p.job } : {}) }; }
  catch (e) {
    if (!(e instanceof CasClientError)) throw e;
    // A cancelled calculation changes nothing: no cell, no error to fix.
    if (e.code === "cancelled") throw Object.assign(new Error("the calculation was cancelled"), { code: "cancelled" });
    return { error: userError(e) };
  }
}

const inputOf = (p) => (p.latex !== undefined ? { latex: p.latex } : p.text !== undefined ? { text: p.text } : p.equations ? { equations: p.equations } : {});
const paramsOf = (p) => { const o = {}; for (const k of ["variable", "variables", "order", "lower", "upper", "point", "direction", "n", "guess", "domain", "mode", "other", "subs"]) if (p[k] !== undefined) o[k] = p[k]; return o; };
// A source of this module changed: the cells named here are what the core marks stale in every document that holds a plot made from them.
const sourceRefOf = (nb, cellId) => nb.id + "/" + cellId;
const changedCells = (nb, ids) => ({ broadcast: [...new Set(ids)].slice(0, 50).map((id) => ({ event: "source-changed", sourceRef: sourceRefOf(nb, id) })) });

// What a result depends on besides its own input: the notebook's
// definitions and assumptions, and its default angle and precision.
// Compared in canonical form (sorted keys).
const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const envKeyOf = (nb) => JSON.stringify(canonical({ env: envOf(nb), angle: nb.angle ?? null, precision: nb.precision ?? null }));

// `envKey` is the environment the result was computed in. A result is
// published as fresh only when the notebook still has that environment;
// if a definition changed while SymPy was working, the result is kept but
// marked stale, so it cannot be plotted until it is recomputed.
function writeCell(nb, cell, p, outcome, resultId, author, envKey) {
  const changed = envKey !== undefined && envKey !== envKeyOf(nb);
  cell.operation = p.operation; cell.input = inputOf(p); cell.params = paramsOf(p);
  cell.angle = p.angle ?? nb.angle; cell.precision = p.precision ?? nb.precision;
  cell.revision = (cell.revision ?? 0) + 1;
  if (outcome.result) {
    cell.result = { ...outcome.result, resultId, computedAt: new Date().toISOString(), author };
    delete cell.error;
    if (changed) { cell.stale = true; cell.staleReason = "the notebook's definitions or settings changed while this was being computed"; }
    else { cell.stale = false; delete cell.staleReason; }
  } else {
    cell.error = outcome.error; // the input stays, so it can be fixed and retried
  }
}

// Calculations under way, by notebook and idempotency key: a second call
// with the same key waits for the first instead of adding another cell.
const inflight = new Map();

async function calculate(p) {
  // Keys are scoped to a notebook; a call that creates a new notebook has
  // nothing to collide with.
  if (!p.idempotencyKey || !p.notebook) return calculateOnce(p);
  const key = p.notebook + "\u0000" + p.idempotencyKey;
  const running = inflight.get(key);
  if (running) {
    const first = await running.catch(() => null);
    // The first call failed or was cancelled: this one runs on its own.
    if (!first) return calculate(p);
    const nb = await deps.notebooks.get(first.data.notebookId);
    const cell = nb.cells.find((c) => c.id === first.data.cell.cellId);
    return cell ? reply(nb, cell, true) : first;
  }
  const run = calculateOnce(p);
  inflight.set(key, run);
  try { return await run; } finally { if (inflight.get(key) === run) inflight.delete(key); }
}

async function calculateOnce(p) {
  needBackend();
  const { notebooks } = deps;
  const by = p.by ?? "model";
  let nb = p.notebook ? await notebooks.get(p.notebook) : await notebooks.create({ angle: p.angle, precision: p.precision });
  const replayOf = (book) => {
    const done = p.idempotencyKey && book.idem?.[p.idempotencyKey];
    return done ? book.cells.find((c) => c.id === done) : null;
  };
  const known = replayOf(nb);
  if (known) return reply(nb, known, true);
  if (p.cell && !nb.cells.some((c) => c.id === p.cell)) throw new Error("no cell " + p.cell + " in " + nb.id);
  const envKey = envKeyOf(nb);
  const outcome = await compute(nb, p);
  const resultId = notebooks.newResultId();
  let cellId, replayed = false;
  nb = await notebooks.mutate(nb.id, { expectedRevision: p.expectedRevision }, (draft) => {
    // The same key finished meanwhile (another process or a retry): reuse it.
    const done = replayOf(draft);
    if (done) { cellId = done.id; replayed = true; return draft; }
    let cell = p.cell && draft.cells.find((c) => c.id === p.cell);
    if (!cell) {
      if (draft.cells.length >= 200) throw new Error("this notebook has 200 cells; start a new notebook or delete some");
      cell = { id: notebooks.newCellId(), links: [] }; draft.cells.push(cell);
    }
    writeCell(draft, cell, p, outcome, resultId, by, envKey);
    cellId = cell.id;
    if (p.idempotencyKey) { draft.idem = { ...(draft.idem ?? {}), [p.idempotencyKey]: cell.id }; const keys = Object.keys(draft.idem); for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete draft.idem[k]; }
    return draft;
  });
  const out = reply(nb, nb.cells.find((c) => c.id === cellId), replayed);
  return p.cell && !replayed ? { ...out, ...changedCells(nb, [cellId]) } : out;
}

function reply(nb, cell, replayed) {
  const s = cellSummary(cell, true);
  const text = s.error ? p0(cell) + " failed (" + s.error.code + "): " + s.error.message
    : cell.operation + ": " + s.result.plain + " [" + s.result.status + ", " + (s.result.engine?.name ?? "SymPy") + " " + (s.result.engine?.version ?? "") + "]" + (s.result.approx ? " ≈ " + s.result.approx : "");
  return { data: { notebookId: nb.id, notebookRevision: nb.revision, cell: s, ...(replayed ? { replayed: true } : {}) }, summary: text.slice(0, 300) };
}
const p0 = (cell) => cell.operation;

async function define(p) {
  needBackend();
  const { notebooks, client } = deps;
  if (RESERVED_NAMES.has(p.name)) throw new Error(p.name + " is a built-in name; pick another");
  const hasBody = p.text !== undefined || p.latex !== undefined;
  if (hasBody && p.assumptions) throw new Error("give a definition (text/latex) or assumptions, not both");
  let body = null;
  if (hasBody) {
    try { body = await client.parse(p.latex !== undefined ? { latex: p.latex } : { text: p.text }); }
    catch (e) { throw new Error("cannot read the definition: " + e.message); }
    const free = new Set(); (function walk(n) { if (n && typeof n === "object") { if (n.node === "symbol") free.add(n.name); Object.values(n).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : walk(v))); } })(body.ast);
    if (free.has(p.name)) throw new Error(p.name + " cannot be defined in terms of itself");
  }
  const nb = p.notebook ? await notebooks.get(p.notebook) : await notebooks.create();
  let newlyStale = [];
  const out = await notebooks.mutate(nb.id, { expectedRevision: p.expectedRevision }, (d) => {
    newlyStale = [];
    if (hasBody) {
      if (Object.keys(d.definitions).length >= 64 && !d.definitions[p.name]) throw new Error("at most 64 definitions per notebook");
      d.definitions[p.name] = { params: p.params ?? [], text: body.text, body: body.ast };
    } else if (p.assumptions) {
      if (p.assumptions.length) d.assumptions[p.name] = p.assumptions; else delete d.assumptions[p.name];
    } else { delete d.definitions[p.name]; delete d.assumptions[p.name]; }
    for (const c of d.cells) if (c.result && !c.stale) { c.stale = true; c.staleReason = "the definition of " + p.name + " changed"; newlyStale.push(c.id); }
    return d;
  });
  return { ...changedCells(out, newlyStale), data: notebooks.summary(out), summary: (hasBody ? "defined " + p.name : p.assumptions ? "assumptions for " + p.name : "removed " + p.name) + "; " + out.cells.filter((c) => c.stale).length + " cell(s) are stale" };
}

async function getNotebook(p) {
  needBackend();
  if (!p.notebook) {
    const list = await deps.notebooks.list();
    return { data: { notebooks: list.slice(0, 50).map((nb) => ({ notebookId: nb.id, revision: nb.revision, title: nb.title, cells: nb.cells.length, updatedAt: nb.updatedAt })) }, summary: list.length + " notebook(s)" };
  }
  const nb = await deps.notebooks.get(p.notebook);
  return { data: deps.notebooks.summary(nb, { cells: p.cells ?? 30, full: p.full }), summary: nb.id + " revision " + nb.revision + ", " + nb.cells.length + " cell(s), " + nb.cells.filter((c) => c.stale).length + " stale" };
}

async function recompute(p) {
  needBackend();
  const { notebooks } = deps;
  const nb = await notebooks.get(p.notebook);
  const todo = nb.cells.filter((c) => (p.cell ? c.id === p.cell : c.stale || c.error)).slice(0, 20);
  if (p.cell && !todo.length) throw new Error("no cell " + p.cell);
  const done = [];
  for (const c of todo) {
    const params = { operation: c.operation, ...c.input, ...c.params, angle: c.angle, precision: c.precision };
    if (params.subs && !Array.isArray(params.subs)) params.subs = Object.entries(params.subs).map(([name, value]) => ({ name, value }));
    const current = await notebooks.get(nb.id);
    const envKey = envKeyOf(current);
    const outcome = await compute(current, { ...params, ...(p.job ? { job: p.job } : {}) });
    const resultId = notebooks.newResultId();
    await notebooks.mutate(nb.id, { expectedRevision: p.expectedRevision !== undefined && !done.length ? p.expectedRevision : undefined }, (d) => {
      const cell = d.cells.find((x) => x.id === c.id);
      if (!cell) return d;
      writeCell(d, cell, params, outcome, resultId, "model", envKey);
      return d;
    });
    done.push(c.id);
  }
  const out = await notebooks.get(nb.id);
  return { ...changedCells(out, done), data: notebooks.summary(out), summary: "recomputed " + done.length + " cell(s)" };
}

async function plotResult(p, ctx) {
  needBackend();
  const nb = await deps.notebooks.get(p.notebook);
  const cell = nb.cells.find((c) => c.id === p.cell);
  if (!cell) throw new Error("no cell " + p.cell + " in " + nb.id);
  if (cell.error || !cell.result) throw new Error("this cell has no result to plot" + (cell.error ? " (" + cell.error.message + ")" : ""));
  if (cell.stale) throw new Error("this result is stale (" + (cell.staleReason ?? "an input changed") + "); recompute it first");
  const domain = p.domain ?? [-10, 10];
  let g;
  try { g = checkPlottable(cell.result, domain); }
  catch (e) { if (e instanceof BridgeError) throw new Error(e.message); throw e; }
  const label = "y = " + (cell.result.exact.plain.length <= 48 ? cell.result.exact.plain.replace(new RegExp("\\b" + g.variable + "\\b", "g"), "x") : g.expression);
  let built;
  if (p.object) {
    built = graph.run("update_plot", { object: p.object, expression: g.expression, ...(p.domain ? { domain: p.domain } : {}), label, labelMode: "custom", ...(p.color ? { color: p.color } : {}) }, ctx);
  } else {
    built = graph.run("plot_function", { expression: g.expression, domain, label, labelMode: "custom", ...(p.color ? { color: p.color } : {}), ...(p.frame ? { frame: p.frame } : {}) }, ctx);
  }
  // A new plot is named, so the core can record that it was made from this cell; a redraw (object given) makes no new object.
  const operations = p.object ? built.operations : built.operations.map((op) => (op?.op === "object.create" && op.type === "function-plot" ? { ...op, ref: "plot" } : op));
  const derived = p.object ? undefined : [{ object: "$plot", sourceRef: sourceRefOf(nb, cell.id), sourceRevision: Math.max(1, cell.revision ?? 1),
    inputsHash: createHash("sha256").update(JSON.stringify({ result: cell.result.resultId, expression: g.expression, domain })).digest("hex") }];
  return { operations, ...(derived ? { derived } : {}), method: "SymPy result " + cell.result.resultId + " drawn by the Graph renderer", summary: built.summary,
    data: { notebookId: nb.id, cellId: cell.id, resultId: cell.result.resultId, expression: g.expression, domain, refreshed: !!p.object } };
}

// Estampes calls this to redraw one derived plot: the cell is recomputed first if it is stale, and only that plot is updated.
async function refreshPlot(p, ctx) {
  needBackend();
  const [notebook, cellId] = String(p.sourceRef).split("/");
  let nb = await deps.notebooks.get(notebook);
  let cell = nb.cells.find((c) => c.id === cellId);
  if (!cell) throw new Error("no cell " + cellId + " in " + notebook);
  if (cell.stale || cell.error) {
    await recompute({ notebook, cell: cellId });
    nb = await deps.notebooks.get(notebook);
    cell = nb.cells.find((c) => c.id === cellId);
  }
  // The plot keeps the domain it was drawn with (the check that it can be drawn there uses it too).
  const domain = canvasObjects(ctx.canvas).find((o) => o.id === p.object)?.props?.domain;
  const out = await plotResult({ notebook, cell: cellId, object: p.object, ...(Array.isArray(domain) && domain.length === 2 ? { domain } : {}) }, ctx);
  return { ...out, data: { ...out.data, sourceRevision: Math.max(1, cell.revision ?? 1) } };
}

// Estampes asks this when a document is opened: which plots on it were drawn from a cell before plots were tracked (their notebook link
// has no `bound` mark). Each is named once, with the cell it came from and whether the link says it is out of date. Nothing is changed here.
async function adoptPlots(p, ctx) {
  if (!deps.notebooks) return { data: { adopted: 0 } };
  const here = new Set((ctx.canvas?.objects ?? []).filter((o) => o.type === "function-plot").map((o) => o.id));
  // An object can carry links from more than one cell (it was drawn from one and redrawn from another): the latest draw is the one it shows.
  const best = new Map();
  for (const nb of await deps.notebooks.list()) {
    for (const cell of nb.cells) {
      for (const l of cell.links ?? []) {
        if (l.canvas !== p.canvas || l.bound === true || l.status === "removed" || !here.has(l.object)) continue;
        const prev = best.get(l.object);
        if (!prev || String(l.at ?? "") > String(prev.l.at ?? "")) best.set(l.object, { nb, cell, l });
      }
    }
  }
  const derived = [...best.entries()].slice(0, 50).map(([object, { nb, cell, l }]) => ({
    object, sourceRef: sourceRefOf(nb, cell.id), sourceRevision: Math.max(1, cell.revision ?? 1),
    inputsHash: createHash("sha256").update(JSON.stringify({ result: l.resultId, expression: l.expression, domain: l.domain ?? [-10, 10] })).digest("hex"),
    ...(!cell.stale && l.status !== "stale" && l.status !== "error" && !(Number.isInteger(l.cellRevision) && l.cellRevision < Math.max(1, cell.revision ?? 1)) ? {} : { stale: true }) }));
  return { ...(derived.length ? { derived } : {}), data: { adopted: derived.length }, summary: derived.length + " earlier plot(s) found" };
}

async function setOptions(p) {
  needBackend();
  const nb = await deps.notebooks.mutate(p.notebook, { expectedRevision: p.expectedRevision }, (d) => {
    if (p.autoRefresh !== undefined) d.autoRefresh = p.autoRefresh;
    return d;
  });
  return { data: { notebookId: nb.id, notebookRevision: nb.revision, autoRefresh: !!nb.autoRefresh }, summary: "auto-refresh " + (nb.autoRefresh ? "on" : "off") + " for " + nb.id };
}

export async function run(capability, params, ctx) {
  if (capability === "calculate") return calculate(params);
  if (capability === "define") return define(params);
  if (capability === "get_notebook") return getNotebook(params);
  if (capability === "recompute") return recompute(params);
  if (capability === "plot_result") return plotResult(params, ctx);
  if (capability === "refresh_plot") return refreshPlot(params, ctx);
  if (capability === "adopt_plots") return adoptPlots(params, ctx);
  if (capability === "set_options") return setOptions(params);
  throw new Error("unknown capability " + capability);
}

// Called by the router after the scene operations were applied, so the
// link from the result to the object exists only for plots that really
// landed on the canvas.
export async function after(capability, params, ctx, { output, scene, entry }) {
  // Plots the core has just recorded as derived: their links are marked so they are never adopted a second time (a plot the person later detaches stays detached).
  if (capability === "adopt_plots" && deps.notebooks) {
    const names = new Set((output.derived ?? []).map((d) => d.object));
    if (!names.size) return;
    for (const nb of await deps.notebooks.list()) {
      if (!nb.cells.some((c) => (c.links ?? []).some((l) => l.canvas === entry.imageId && names.has(l.object) && l.bound !== true))) continue;
      await deps.notebooks.mutate(nb.id, {}, (d) => { for (const c of d.cells) for (const l of c.links ?? []) if (l.canvas === entry.imageId && names.has(l.object)) l.bound = true; return d; });
    }
    return;
  }
  if ((capability !== "plot_result" && capability !== "refresh_plot") || !deps.notebooks) return;
  const d = output.data;
  const plots = new Set(canvasObjects(entry).filter((o) => o.type === "function-plot").map((o) => o.id));
  const objectId = params.object ?? scene.created.find((id) => plots.has(id));
  if (!objectId) return;
  const link = (nb) => {
    const cell = nb.cells.find((c) => c.id === d.cellId);
    if (!cell) return nb;
    const was = (cell.links ?? []).find((l) => l.canvas === entry.imageId && l.object === objectId);
    cell.links = (cell.links ?? []).filter((l) => !(l.canvas === entry.imageId && l.object === objectId));
    cell.links.push({ canvas: entry.imageId, object: objectId, resultId: d.resultId, expression: d.expression, domain: capability === "refresh_plot" ? (was?.domain ?? d.domain) : d.domain, cellRevision: Math.max(1, cell.revision ?? 1), at: new Date().toISOString(),
      // Made or redrawn through a binding: never adopted. A redraw by the older path (object given to plot_result) keeps what the link said before.
      ...(capability === "refresh_plot" || !params.object || was?.bound === true ? { bound: true } : {}) });
    return nb;
  };
  // The plot is already saved; a link lost to a passing storage error would
  // leave a plot that never refreshes, so the write is tried a few times.
  for (let attempt = 1; ; attempt++) {
    try { await deps.notebooks.mutate(d.notebookId, {}, link); return; }
    catch (error) {
      if (attempt >= 3 || error?.code === "conflict") throw error;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}
