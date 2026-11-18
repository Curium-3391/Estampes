# Testing modules

What to test, at which level, and with which command. Each level is something the repository already does; the test names below are real files you can copy from.

Reference: [Module quick start](QUICKSTART.md), [Modules](../MODULES.md), [Development guide](../DEVELOPMENT.md).

## The levels

| Level | Question it answers | Tool | Needs a server? |
| --- | --- | --- | --- |
| 0. One run | What does this call draw? | `node scripts/estampes-module.js try module.json <capability> --example 1 --out result.png` | no |
| 1. Manifest and examples | Is the manifest valid for this core, do my examples produce operations the core accepts, and (http) does my response mapping work on a recorded reply? | `node scripts/estampes-module.js test module.json` | no |
| 2. Package | Is the package intact, signed and trusted for this id? | `pack`, `verify`, `trust`, `inbox` | no |
| 3. Scene operations | Does the core accept my batches, and does a refused batch change nothing? | unit tests on `applySceneOps` (`tests/scene-ops.test.js`) | no |
| 4. Install and run | Does the whole flow work: plan, consent, administrator approval, enable, run, refusal? | MCP client against a real `server.js` (`tests/module-authoring.test.js`, `tests/packages.test.js`) | yes (started by the test) |
| 5. In ChatGPT | Does the model use it well, and does the widget show the result? | a live conversation | yes (tunnel) |

Level 5 is **not automated**; nothing in the repository's CI covers a real ChatGPT host.

## 1. Manifest and examples

```sh
node scripts/estampes-module.js test mymodule/module.json
```

`test` validates the manifest (strict: unknown fields, unsafe schemas and ids that are not reverse-DNS are refused), checks that the declared permissions cover every capability, then runs each capability's `examples` through the runtime and applies the resulting operations to a scratch canvas. For a WebAssembly module it also runs the package checks (no imports, a declared memory maximum within `limits.memoryMb`).

Write at least one example per capability and add one for each edge you care about (smallest and largest allowed values). Your examples are the regression suite the install runs again on every update.

All bundled examples pass; `tests/module-authoring.test.js` runs `test` on each directory in `examples/modules/`.

## 2. Package checks

`verify` reports exactly why a package is refused: a digest that does not match, a signature by an untrusted key, a key trusted only for another id prefix (`trust` takes the prefix), reserved ids, unsafe file names, or an unsigned package without `ESTAMPES_MODULE_ALLOW_UNSIGNED=1`. `tests/packages.test.js` has the cases ("package verification: digest, signature, scope, tampering, reserved ids, bad files").

## 3. Scene operations

A module never draws. It returns `estampes.scene-ops/1` operations and the core applies them. The rules, with the test that shows each in `tests/scene-ops.test.js`:

| Rule | What you will see |
| --- | --- |
| **All or nothing.** A batch is applied completely or not at all, and the error names the operation. | `operations[1]: …`; the canvas has no new objects and its scene revision did not move. |
| **Unknown operations and object types** are refused. | `known operations …`; an object type like `script` is a `SceneOpsError`. |
| **Own objects only.** A module may update or delete only objects it created; the user may change anything. | `… only update its own …` |
| **Optimistic concurrency.** Pass `expectedRevision`; if the canvas moved, the call is refused. | `conflict` ("the canvas changed since revision N (now M); read it again and retry") |
| **In-use frames.** Deleting axes that a plot uses needs `cascade: true`. | `in-use` |
| **Locked layers.** No changes to objects in a locked layer. | `locked` |
| **Limits.** At most 64 operations per batch and 200 objects per canvas; props are validated per object type. | an error naming the field |

For a declarative module most of this is checked by `test`; for `wasm` and `http` modules, where the reply is data your code (or the service) produced, add examples that exercise every operation you can emit (for http: one `mockResponse` per reply shape), and pin the numbers with `expect`, because a bad operation in a real call is refused after the work is done.

### Testing a transaction failure

The simplest way is a unit test next to `tests/scene-ops.test.js`:

```js
assert.throws(() => applySceneOps(canvas, [goodOp, badOp, goodOp], moduleCtx), /operations\[1\]/);
assert.equal(canvasObjects(canvas).length, 0);   // nothing from the first good operation survived
assert.equal(sceneRevision(canvas), 0);          // and the revision did not move
```

Over MCP, an input outside the capability's schema is refused before your module runs and the canvas stays untouched; `tests/module-authoring.test.js` checks both that the call errors and that the object count and scene revision stay the same.

## 4. Install and run over MCP

`tests/module-authoring.test.js` is a worked example you can copy. It, in order:

1. creates a module with `init`, tests it, breaks an example and sees the failure, signs, packs, verifies (refused), trusts, verifies (accepted), puts it in the inbox;
2. starts the real server on a temporary storage folder (`ESTAMPES_ALLOW_OPEN=1`);
3. calls `prepare_module_change` (install), runs the CLI `approve <planId>` as the administrator, then `store_commit_plan` with the consent token that only the Store widget normally receives (`prep._meta["estampes/consent"].consent`);
4. enables the module, makes a canvas with Graph (`execute_module` with `newCanvas`), and runs the capability with `canvas: <imageId>`;
5. sends invalid input and checks that the call fails and nothing changed.

### Permissions

A capability runs only if the module is **enabled** and every permission it needs was **granted** when it was enabled. The messages:

- "`<id>` is installed/disabled. Only the user can enable it …": run the enable plan first.
- "`<id>` was not granted `<permission>`; the user must approve it again in the Store": your manifest now asks for more than the user approved; an update that adds permissions needs a new approval. `tests/packages.test.js` ("update adds permissions, rollback restores the exact earlier bytes …") covers it.

Ask for the least permission that works (`canvas.write` for adding objects). A module that asks for `network.request.approved` is shown as high risk and needs the administrator.

### Revisions

Each canvas has a scene revision that every applied batch increases. Read it from `get_visual_state` (`sceneRevisions`) or from the result of `execute_module` (`module.revision`) and pass it back as `expectedRevision` when your capability depends on what it read. A conflict is an error, not a silent overwrite.

## WebAssembly specifics

Limits are enforced by killing the worker. `tests/packages.test.js` has the cases: an endless loop (`limits.timeMs`), memory growth (`limits.memoryMb`), a trap and an oversized reply (`limits.outputKb`) are stopped without harming the server; imports, a missing memory maximum or too much memory are refused at verification. The example's `spin` capability exists to demonstrate the time limit.

## HTTP specifics

`test` (and the install self-test) never calls the network. For each example it builds the request and checks it against the egress rules (host, path, headers, declared secrets) without sending it and without reading secret values. To test the **response mapping** as well, give the example a `mockResponse`: the reply your service would send. It then goes through exactly the code a real call uses (`mapResponse` in `src/modules/runtimes/http.js`): status check, JSON parsing, `response.data`, the `{"$response": …}` templates, and the scene-operation checks on the result.

```json
"examples": [
  { "description": "The service answers",
    "params": { "text": "hello", "x": 0.2, "y": 0.3 },
    "mockResponse": { "status": 200, "json": { "result": { "text": "hello", "confidence": 0.98 } } },
    "expect": { "operations": 1, "data": { "text": "hello" } } },
  { "description": "The service is down",
    "params": { "text": "hello" },
    "mockResponse": { "status": 503, "json": { "error": "unavailable" } },
    "expect": { "error": "answered 503" } }
]
```

- `mockResponse`: `status` (default 200) and either `json` (the parsed reply) or `text` (a raw body, to test what happens when the service does not answer JSON). A 3xx status fails like a real redirect (never followed); 4xx and 5xx fail with `the host answered <status>`. At most 64 KB per example, so paste a trimmed real reply.
- A `{"$response": "a.b"}` path, or `response.data`, that is not in the mock reply and has no `default` is an error (`response mapping: "a.b" not found in the reply`). Real calls stay lenient (a missing field is left out), so this is how you catch typos.
- `expect` (any runtime): `operations` (how many scene operations), `data` (a pattern: every key you list must match, extra keys are fine, arrays must have the same length, numbers may differ by 1e-9 relative), `summary`, or `error` (a substring of the message the call must fail with, including input refused by the schema). An http example can only check a result against a `mockResponse`.
- An http example without a `mockResponse` still passes, with a warning: `response mapping not tested; add a mockResponse`.

The fixtures are part of the manifest, so the install self-test on the administrator's server runs them again and a package whose mapping no longer matches its own fixtures is never activated. They are not sent to the model: `get_module_capabilities` lists only each example's description and parameters.

What a mock cannot tell you: whether the real service still answers in that shape, its latency, and the egress rules that only apply at connection time (DNS must resolve to public addresses, TLS, size and time limits). Those are covered by "egress refuses other hosts, paths, headers, undeclared secrets, redirects, errors and missing permissions" in the repository's tests and by one real call after the administrator enabled the module.

## Before you share it

- `node scripts/estampes-module.js test` passes and every capability has examples.
- The permission list is the smallest that works, and each `network.allow` host and `dataFlow` sentence is true.
- You tested the install flow once end to end (level 4), and, if you can, once in ChatGPT (level 5). Say in your README which of these you did.

## Common messages

`expect.error` matches a substring of the message, so use the stable part. These are the texts today (`<path>` is the field, such as `add_label example.x`):

| Situation | Message contains |
| --- | --- |
| number too small / large | `must be >= 0`, `must be <= 1`, `must be > 0`, `must be < 1` |
| wrong type | `expected number, got string` |
| value not allowed | `must be one of "a", "b"`; for a fixed value `must be "x"` |
| string length | `at least 1 character`, `at most 80 characters` |
| list length | `at least 1 item`, `at most 10 items` |
| missing required field | `.<name>: required` |
| extra field | `unknown field "<name>"` |
| pattern | `does not match <pattern>` |
| a capability targeting a canvas without `canvas.write` | `needs canvas.write` |
| `canvas-or-new` without `workspace.write` | `target canvas-or-new needs workspace.write` |
| invalid manifest field | `manifest.<field>: …` (for example `manifest.category: Invalid option: expected one of …`) |
| bad object property | `operations[<n>]: props.<name>: …` |
| operation on a missing object | `operations[<n>]: no such object` |
