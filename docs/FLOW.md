# Flow (work in progress)

A Flow connects module capabilities into a small graph: the typed result of one capability feeds an input of another, and a change upstream marks what depends on it stale. It builds on what exists: capability manifests ([Modules](MODULES.md)), the derived-binding vocabulary ([Derived bindings](DERIVED-BINDINGS.md)) and the router that runs every capability with its permission checks. It does **not** replace derived bindings (those keep tying a drawn object to its source); they stay separate.

Status: the graph format, its static checks and a runner exist (F1-1 to F1-3), as a library. Storing a flow and the MCP tools to edit one (F1-4) do not yet; there is no Flow view.

## What exists

- **Typed results.** A module/2 capability may declare `outputSchema`; see [Modules](MODULES.md). A capability without one cannot be an upstream node.
- **The graph, `estampes.flow/1`** (`src/flow/graph.js`): `nodes: [{ id, module, capability, params? }]` and `edges: [{ from: { node, port }, to: { node, port } }]`. A port is a field: an output port is a property of the upstream capability's `outputSchema`, an input port a property of the downstream capability's `inputSchema`. `params` holds literal inputs. At most 64 nodes and 256 edges; node ids are lowercase words such as `rc1`.
- **Static checks, `validateFlow(flow, registry)`.** It names where and why: every node's module and capability is installed; a node works without a document (`target: none`) and answers at once (no background job); literals fit the input's own schema; an edge goes from a typed output to a real input and the types are compatible (`assignable` in `src/modules/schema-compat.js`, conservative: not proven means refused); an input has at most one feeder and not also a literal; every required input is supplied; there is no loop (loops are not supported yet). A valid flow also gets a run order (every node after those that feed it).

Nothing in it names a module (the runner does not either): all it knows about a node comes from that module's own manifest. The tests use invented modules (an RC low-pass: parameters, cutoff, response).

- **Running, `runFlow` / `plan`** (`src/flow/run.js`). One `router.execute` per node in dependency order, so each node keeps the router's checks (module enabled and granted, input validation, the declared `outputSchema`, audit). The runner stores nothing: it is given the flow and the earlier per-node results (`state`) and returns the new state. Each result is kept with the hash of exactly what it was computed from (module version, capability, literal and fed inputs), a revision, and the time. A run recomputes only nodes whose inputs changed; a node whose new result is identical keeps its revision, so what follows it is not recomputed (early cutoff). A node that fails keeps its last good data and the nodes that need it are `blocked`, not wrong; going back to inputs it already has an answer for needs no run. A cancelled run (an `AbortSignal`, checked between nodes) keeps what it finished and lists the rest as `cancelled`. `plan` says what a run would do (`fresh`, `stale`, `blocked`) without running anything; a node behind a stale one shows `stale` with `pending`, since it may still turn out unchanged.

## Not yet

Storing a flow as a document and its results, the `get_flow` / `edit_flow` tools, running a node mid-flight from a person's edit, a Flow view on the module-view contract, background-job nodes, nodes that work on a document (drawing), and loops. a Flow view on the module-view contract, and loops. See issue #86.
