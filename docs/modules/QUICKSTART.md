# Module quick start

Build, test, sign and install a small module that puts a text label on a canvas. About 15 minutes. Every command here is run by `tests/module-authoring.test.js`, so if a step stops working, that test fails.

Reference: [Modules](../MODULES.md) (the full contract), [Testing modules](TESTING.md). You only need Node 22 and a clone of the repository (`npm ci`). No ChatGPT is needed for steps 1–5.

## What you are building

A **declarative** module: a manifest with scene-operation templates and no code. It asks for one permission (`canvas.write`), so it can add objects to a canvas, and nothing else. It cannot read files, use the network or run code. When a template is not enough, there are two other runtimes (see [Choosing a runtime](#choosing-a-runtime)).

## 1. Work in a scratch storage folder

The module CLI keeps trusted keys and the install inbox in the server's storage folder (`/data` by default). While developing, use a throwaway one so you never touch a real server:

```sh
export ESTAMPES_STORAGE_DIR=$(mktemp -d)
```

Use the same variable when you start a development server in step 6.

## 2. Create it

```sh
node scripts/estampes-module.js init mymodule org.example.labeler
```

Expected: `Created mymodule/module.json. Next: node scripts/estampes-module.js test mymodule/module.json`. The id is reverse-DNS (`org.example.labeler`); `init` refuses to overwrite files you already have. `mymodule/module.json` now holds one capability, `add_label`:

- `inputSchema` declares `x`, `y` (0 to 1, normalized to the canvas with the origin at the top left) and `text`;
- `operations` has one `object.create` of a `shape` of kind `text`, with `{"$param": "x"}` placeholders filled from the validated input;
- `examples` has one example call. **Examples are required in practice**: they are what the install self-test runs and what the Store shows.

## 3. Test it

```sh
node scripts/estampes-module.js test mymodule/module.json
```

Expected: `OK org.example.labeler 0.1.0: manifest valid, 1 example(s) passed`. This is the same check an install makes: the manifest is validated and every example runs through the scene-operation rules.

Break it on purpose to see how errors read. Change an example to `"x": 2` and run again:

```
estampes-module: self-test: add_label example.x: must be <= 1
```

Other messages you will meet: a capability that targets a canvas without `canvas.write` (`needs canvas.write`), a template with an invalid property (`operations[0]: props.kind: Invalid option …`), or an operation on something that does not exist (`operations[1]: no such object`). Fix the manifest and rerun until it prints `OK`.

## 4. Sign and pack it

```sh
node scripts/estampes-module.js keygen mykey
node scripts/estampes-module.js pack mymodule/module.json --out org.example.labeler.estpkg.json --key mykey.private.pem --key-id mykey
```

Expected: `Wrote org.example.labeler.estpkg.json  digest … signed`. Keep `mykey.private.pem` secret; give `mykey.public.pem` to administrators. An unsigned package is refused unless the server sets `ESTAMPES_MODULE_ALLOW_UNSIGNED=1`, and is always shown as high risk.

## 5. Trust the key and put the package in the inbox

This is what a server administrator does with a package you send them.

```sh
node scripts/estampes-module.js verify org.example.labeler.estpkg.json      # fails first: the key is not trusted yet
node scripts/estampes-module.js trust mykey mykey.public.pem "Example Author" org.example
node scripts/estampes-module.js verify org.example.labeler.estpkg.json      # OK … signed by Example Author (mykey)
node scripts/estampes-module.js copy org.example.labeler.estpkg.json
node scripts/estampes-module.js inbox
```

The first `verify` exits with `signed by key mykey, which this server does not trust`. `trust` limits the key to ids beginning with `org.example`, so a key you were given for one prefix cannot publish another's modules. `inbox` lists `ok   org.example.labeler 0.1.0 signed by Example Author`.

For publishing to many servers, put the package and a signed index on a GitHub Release instead; administrators then add your source once and `source sync` brings every update into the inbox. See [Distributing modules](DISTRIBUTION.md).

## 6. Install, enable, run

Start a development server on the same storage folder (see the [development guide](../DEVELOPMENT.md#run-the-server)):

```sh
ESTAMPES_ALLOW_OPEN=1 npm start
```

In ChatGPT (through a tunnel; see [Deployment](../DEPLOYMENT.md)): ask *"Open the Estampes Store"*, find the package under installable packages and press **Install**. The Store shows the plan with its permissions and a command such as:

```sh
node scripts/estampes-module.js approve <planId>
```

Run it in the same terminal environment (same `ESTAMPES_STORAGE_DIR`), then press **Confirm** in the Store. Installing needs both you (the user) and the administrator, and the administrator's approval is a file written on the server, so ChatGPT cannot give it. Installing does not enable the module: enabling is a second plan that shows the permissions; confirm it too.

`add_label` targets an **existing canvas** (the template's `target` is `canvas`). Ask ChatGPT to plot a function with Graph first, then: *"Add the label 'hello' near the top left."* Expected: a text object appears on the canvas, in its own layer named after your module.

Without ChatGPT, `tests/module-authoring.test.js` drives exactly this sequence over MCP (prepare, approve, commit, enable, `execute_module`); copy from it to script your own checks.

## Choosing a runtime

| Runtime | Use when | Needs | Try it |
| --- | --- | --- | --- |
| `declarative` | Fixed templates: symbols, callouts, stamps | nothing | this page; `examples/modules/callout` |
| `wasm` | Real computation, offline, sandboxed: no imports, no clock, no files, no network, killed after the call | a C/Rust/… toolchain that targets `wasm32` | `examples/modules/wasm-hello` |
| `http` | A call to an external service the administrator approves | the service's host named in `network.allow`, secrets set with `secret set` | `examples/modules/ocr-http` |

### WebAssembly path

`node scripts/estampes-module.js init mymodule org.example.mymodule --runtime wasm` writes the manifest and a README; you provide `module.wasm`. The ABI (`estampes.wasm/1`: export `memory`, `alloc`, `handle`) is in [Modules](../MODULES.md#webassembly-modules). The example is complete and reproducible. With clang and `wasm-ld`:

```sh
(cd examples/modules/wasm-hello && clang --target=wasm32 -O2 -nostdlib -ffreestanding -Wl,--no-entry -Wl,--export=alloc -Wl,--export=handle \
  -Wl,--initial-memory=262144 -Wl,--max-memory=1048576 -o hello.wasm hello.c)
node scripts/estampes-module.js test examples/modules/wasm-hello/module.json
```

(The build runs in a subshell, so the next commands still start from the repository root.)

The rebuilt `hello.wasm` was byte-identical to the one in the repository. The `wasm` file must be added to the package with `--file`:

```sh
node scripts/estampes-module.js pack examples/modules/wasm-hello/module.json --out w.estpkg.json \
  --key mykey.private.pem --key-id mykey --file hello.wasm=examples/modules/wasm-hello/hello.wasm
```

A package whose memory maximum is missing or above `limits.memoryMb`, or that imports anything, is refused at verification, before anything runs.

### HTTP path

`node scripts/estampes-module.js init mymodule org.example.mymodule --runtime http` writes a manifest that passes `test` as it is: one capability with a `request` (fixed path; query and body filled from `{"$param": …}`), a `response` mapped back to scene operations with `{"$response": "a.b"}`, and two examples with a `mockResponse` (a reply and a failure). `examples/modules/ocr-http/module.json` is a fuller one. The manifest must list hosts in `network.allow` and say in `network.dataFlow` what leaves the server; the Store shows both.

`module test` never touches the network. It checks that the request each example produces is allowed (host, path, headers, secrets declared) without sending it and, for each example with a `mockResponse`, runs that reply through the same response mapping a real call uses, so a typo in a `$response` path or a reply your templates cannot turn into valid operations fails here, offline. Paste a real reply of your service (trimmed to 64 KB) into `mockResponse` and pin what you expect with `expect`; see [HTTP specifics](TESTING.md#http-specifics). A real call needs the permission `network.request.approved`, the administrator's approval and, if declared, the secret. See [Talking to external services](../MODULES.md#talking-to-external-services-http-modules).

## Where next

- [Testing modules](TESTING.md): scene operations, permissions, revisions and transaction failures.
- Publish: send the `.estpkg.json` and your public key to the administrator, or publish a package source ([Distributing modules](DISTRIBUTION.md)).
