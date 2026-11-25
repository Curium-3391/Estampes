# Flow (work in progress)

A Flow connects module capabilities into a small graph: the typed result of one capability feeds an input of another, and a change upstream marks what depends on it stale. It builds on what exists: capability manifests ([Modules](MODULES.md)), the derived-binding vocabulary ([Derived bindings](DERIVED-BINDINGS.md)) and the router that runs every capability with its permission checks. It does **not** replace derived bindings (those keep tying a drawn object to its source); they stay separate.

Status: the graph format, its static checks, a runner, storage and two MCP tools (`get_flow`, `edit_flow`) exist (F1). There is no Flow view yet. Everything is tested in-process with invented modules; it has not been tried on a real ChatGPT or Claude host.

## What exists

- **Typed results.** A module/2 capability may declare `outputSchema`; see [Modules](MODULES.md). A capability without one cannot be an upstream node.
- **The graph, `estampes.flow/1`** (`src/flow/graph.js`): `nodes: [{ id, module, capability, params? }]` and `edges: [{ from: { node, port }, to: { node, port } }]`. A port is a field: an output port is a property of the upstream capability's `outputSchema`, an input port a property of the downstream capability's `inputSchema`. `params` holds literal inputs. At most 64 nodes and 256 edges; node ids are lowercase words such as `rc1`.
- **Static checks, `validateFlow(flow, registry)`.** It names where and why: every node's module and capability is installed; a node works without a document (`target: none`) and answers at once (no background job); literals fit the input's own schema; an edge goes from a typed output to a real input and the types are compatible (`assignable` in `src/modules/schema-compat.js`, conservative: not proven means refused); an input has at most one feeder and not also a literal; every required input is supplied; there is no loop (loops are not supported yet). A valid flow also gets a run order (every node after those that feed it).

Nothing in it names a module (the runner does not either): all it knows about a node comes from that module's own manifest. The tests use invented modules (an RC low-pass: parameters, cutoff, response).

- **Running, `runFlow` / `plan`** (`src/flow/run.js`). One `router.execute` per node in dependency order, so each node keeps the router's checks (module enabled and granted, input validation, the declared `outputSchema`, audit). The runner stores nothing: it is given the flow and the earlier per-node results (`state`) and returns the new state. Each result is kept with the hash of exactly what it was computed from (module version, capability, literal and fed inputs), a revision, and the time. A run recomputes only nodes whose inputs changed; a node whose new result is identical keeps its revision, so what follows it is not recomputed (early cutoff). A node that fails keeps its last good data and the nodes that need it are `blocked`, not wrong; going back to inputs it already has an answer for needs no run. A cancelled run (an `AbortSignal`, checked between nodes) keeps what it finished and lists the rest as `cancelled`. `plan` says what a run would do (`fresh`, `stale`, `blocked`) without running anything; a node behind a stale one shows `stale` with `pending`, since it may still turn out unchanged.

## Storing and editing (F1-4)

A flow is a UVA record of kind `flow` (`fl:<12 hex>`, `src/flow/store.js`), so it has the durability, restart recovery and backup coverage of every other record and no storage of its own. The record holds the graph, the results of the last runs and a bounded history (the last 20 changes, within 256 KB, each with the graph it replaced). It shares its revision, locking and command-id rules with model instances (`src/records/revisioned.js`).

- **Edits** are named operations (`src/flow/edit.js`): `add_node`, `remove_node` (its connections go with it), `set_params`, `connect`, `disconnect`. An edit names the revision it was made against; if the flow changed since, nothing is applied and the caller reads it again. The same command id again answers with the first result and changes nothing. An undo restores what an edit replaced, only while that edit is still the latest change.
- **A flow may be incomplete while it is built.** The store checks the shape and size (64 nodes, 256 edges, 64 KB), not that modules exist or types fit; `get_flow` reports what `validateFlow` finds. Only a valid flow runs.
- **Run** (`edit_flow` with `action: "run"`) recomputes the stale nodes through the router and keeps the results in the record, but only if the graph is still the revision the run started from. One run per flow at a time. Results of one flow are limited to 256 KB; a larger set is not kept and the run says so.
- Limits: at most 32 flows; a flow cannot be deleted yet (there is no record delete in the store). Flows need the UVA store; without it the tools say so and change nothing.

## Not yet

Deleting a flow, running a node as soon as a person edits it, a Flow view on the module-view contract (F2), background-job nodes, nodes that work on a document (drawing), streaming, and loops. See issue #86.
