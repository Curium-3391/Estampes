# Flow (work in progress)

A Flow connects module capabilities into a small graph: the typed result of one capability feeds an input of another, and a change upstream marks what depends on it stale. It builds on what exists: capability manifests ([Modules](MODULES.md)), the derived-binding vocabulary ([Derived bindings](DERIVED-BINDINGS.md)) and the router that runs every capability with its permission checks. It does **not** replace derived bindings (those keep tying a drawn object to its source); they stay separate.

Status: the graph format and its static checks exist (F1-1, F1-2). Running a flow, storing one and the MCP tools to edit one (F1-3, F1-4) do not yet; there is no Flow view.

## What exists

- **Typed results.** A module/2 capability may declare `outputSchema`; see [Modules](MODULES.md). A capability without one cannot be an upstream node.
- **The graph, `estampes.flow/1`** (`src/flow/graph.js`): `nodes: [{ id, module, capability, params? }]` and `edges: [{ from: { node, port }, to: { node, port } }]`. A port is a field: an output port is a property of the upstream capability's `outputSchema`, an input port a property of the downstream capability's `inputSchema`. `params` holds literal inputs. At most 64 nodes and 256 edges; node ids are lowercase words such as `rc1`.
- **Static checks, `validateFlow(flow, registry)`.** It names where and why: every node's module and capability is installed; a node works without a document (`target: none`) and answers at once (no background job); literals fit the input's own schema; an edge goes from a typed output to a real input and the types are compatible (`assignable` in `src/modules/schema-compat.js`, conservative: not proven means refused); an input has at most one feeder and not also a literal; every required input is supplied; there is no loop (loops are not supported yet). A valid flow also gets a run order (every node after those that feed it).

Nothing in it names a module: all it knows about a node comes from that module's own manifest. The tests use invented modules (an RC low-pass: parameters, cutoff, response).

## Not yet

Running a flow (one `router.execute` per node, in order), keeping each node's last output with the revision and input hash it came from, marking downstream nodes stale, storing a flow as a document, the `get_flow` / `edit_flow` tools, a Flow view on the module-view contract, and loops. See issue #86.
