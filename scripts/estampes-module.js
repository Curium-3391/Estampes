#!/usr/bin/env node
// Administrator and author tool for Estampes modules. Run it where the
// server's storage folder is (inside the container: docker compose exec
// estampes node scripts/estampes-module.js ...). Nothing here talks to a
// network; ESTAMPES_STORAGE_DIR (default /data) says where the server keeps modules.
//
//   keygen <keyId> [dir]              new ed25519 signing key pair (author)
//   pack <module.json> --out <file> [--key private.pem --key-id <id>]
//                                     bundle a manifest (and --file name=path data files) into a package
//   verify <package>                  check a package against this server's trusted keys
//   trust <keyId> <public.pem> <publisher> <scope>...   trust a publisher key for module id prefixes
//   inbox                             list packages waiting in the inbox
//   approve <planId>                  approve a plan that needs administrator approval
//   secret set <moduleId> <name>     store an API key for a module (the value is read from standard input)
//   secret status <moduleId>          which declared secrets are set (names only)
//   init <dir> <id> [--runtime declarative|wasm|http]   start a new module (manifest, example, README)
//   test <module.json>                check a manifest and run its examples the way an install would
//                                     (http examples with a mockResponse also run the response mapping, offline)
import { readFile, writeFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createPackages, generateSigningKey, signBundle, verifyBundle, digestOf, ensureDirs, selfTest } from "../src/modules/packages.js";
import { validateManifest, MODULE_ID } from "../src/modules/manifest.js";
import { declarativeRuntime } from "../src/modules/runtimes/declarative.js";
import { createHttpRuntime } from "../src/modules/runtimes/http.js";
import { createEgress, createSecrets, envName } from "../src/modules/egress.js";
import { wasmRuntime, WASM_ABI, wasmFileOf, checkWasmPackage } from "../src/modules/runtimes/wasm.js";
import { resolveAdminKey, writeApproval } from "../src/modules/admin.js";
import { createRegistry } from "../src/modules/registry.js";
import { createAudit } from "../src/modules/audit.js";

const storage = process.env.ESTAMPES_STORAGE_DIR || "/data";
const dir = join(storage, "modules");
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf("--" + name); return i >= 0 ? rest[i + 1] : undefined; };
const die = (message) => { console.error("estampes-module: " + message); process.exit(1); };
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

async function trustedKeys() {
  try { return new Map(JSON.parse(await readFile(join(dir, "trusted-keys.json"), "utf8")).map((k) => [k.keyId, k])); } catch { return new Map(); }
}

// What `init` writes: one capability that passes `test` as it is.
function starterManifest(id, kind, coreVersion) {
  const label = { kind: "text", x: { $param: "x" }, y: { $param: "y" }, text: { $param: "text" } };
  const point = { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } };
  const base = {
    schema: "estampes.module/1", id, name: id.split(".").at(-1), description: "What this module does, in one sentence.", version: "0.1.0",
    publisher: { name: "Your name" }, license: "MPL-2.0", category: "other", coreCompatibility: ">=" + coreVersion + " <1.0.0",
  };
  if (kind === "http") {
    return {
      ...base,
      runtime: { kind: "http", entry: "request" },
      permissions: ["canvas.write", "network.request.approved"],
      network: { allow: ["api.example.org"], dataFlow: "Sends the text you give it to api.example.org. Nothing else leaves the server." },
      limits: { timeMs: 8000, outputKb: 64 },
      capabilities: [{
        id: "analyze_text", title: "Analyze text", description: "Send a short text to the service and write its answer on the canvas at (x, y), normalized 0..1 from the top left.", target: "canvas",
        inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 200 }, ...point } },
        examples: [
          { description: "The service answers", params: { text: "hello", x: 0.1, y: 0.1 },
            mockResponse: { status: 200, json: { result: { label: "greeting", score: 0.97 } } },
            expect: { operations: 1, data: { label: "greeting" } } },
          { description: "The service fails", params: { text: "hello" }, mockResponse: { status: 503, json: { error: "busy" } }, expect: { error: "answered 503" } },
        ],
        request: { method: "POST", path: "/v1/analyze", body: { text: { $param: "text" } } },
        response: { data: "result", operations: [{ op: "object.create", type: "shape", props: { kind: "text", x: { $param: "x", default: 0.1 }, y: { $param: "y", default: 0.1 }, text: { $response: "result.label" } } }] },
        profile: {
          whenToUse: "Short text you want the service to classify.",
          cost: { latency: "seconds" },
          dataFlow: { leavesServer: true, sends: "The text you give it goes to api.example.org." },
          reliability: { kind: "external", note: "The answer is whatever the service returns." },
          fallbacks: [{ when: "the service is unreachable", then: "Say so; do not invent an answer." }],
        },
      }],
    };
  }
  const wasm = kind === "wasm";
  return {
    ...base,
    runtime: wasm ? { kind: "wasm", entry: "module.wasm", abi: WASM_ABI } : { kind: "declarative", entry: "operations" },
    permissions: ["canvas.write"], ...(wasm ? { limits: { timeMs: 500, memoryMb: 16, outputKb: 64 } } : {}),
    capabilities: [{
      id: "add_label", title: "Add a label", description: "Put a text label on the canvas at (x, y), normalized 0..1 from the top left.", target: "canvas",
      inputSchema: { type: "object", additionalProperties: false, required: ["x", "y", "text"], properties: { ...point, text: { type: "string", maxLength: 60 } } },
      examples: [{ description: "A label near the top left", params: { x: 0.1, y: 0.1, text: "hello" } }],
      ...(wasm ? {} : { operations: [{ op: "object.create", type: "shape", props: label }] }),
    }],
  };
}

try {
  if (cmd === "keygen") {
    const [keyId, out = "."] = rest;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId ?? "")) die("keygen <keyId> [dir]; keyId is letters, digits, . _ -");
    const { publicKey, privateKey } = generateSigningKey();
    await mkdir(out, { recursive: true });
    await writeFile(join(out, keyId + ".private.pem"), privateKey, { mode: 0o600 });
    await writeFile(join(out, keyId + ".public.pem"), publicKey);
    console.log("Wrote " + join(out, keyId + ".private.pem") + " (keep secret) and " + join(out, keyId + ".public.pem") + " (give to administrators).");
  } else if (cmd === "pack") {
    const [manifestPath] = rest, out = flag("out");
    if (!manifestPath || !out) die("pack <module.json> --out <file> [--key private.pem --key-id id] [--file name=path ...]");
    const files = {};
    rest.forEach((a, i) => { if (a === "--file") { const [name, path] = rest[i + 1].split("="); files[name] = path; } });
    const bundle = { schema: "estampes.package/1", manifest: JSON.parse(await readFile(manifestPath, "utf8")), files: {} };
    for (const [name, path] of Object.entries(files)) {
      const bytes = await readFile(path);
      // Text only when decoding and re-encoding gives back the same bytes.
      const decoded = bytes.toString("utf8");
      const text = Buffer.from(decoded, "utf8").equals(bytes) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded);
      bundle.files[name] = text ? { encoding: "utf8", content: bytes.toString("utf8") } : { encoding: "base64", content: bytes.toString("base64") };
    }
    const signed = flag("key") ? signBundle(bundle, await readFile(flag("key"), "utf8"), flag("key-id") ?? die("--key-id is needed with --key")) : bundle;
    await writeFile(out, JSON.stringify(signed, null, 2));
    console.log("Wrote " + out + "  digest " + digestOf(signed) + (flag("key") ? "  signed" : "  UNSIGNED"));
  } else if (cmd === "verify") {
    const bytes = await readFile(rest[0] ?? die("verify <package>"));
    const trusted = await trustedKeys();
    const v = verifyBundle(bytes, { trusted: new Map([...trusted].map(([id, k]) => [id, { ...k, scopes: k.scopes ?? [] }])), allowUnsigned: process.env.ESTAMPES_MODULE_ALLOW_UNSIGNED === "1", coreVersion: version });
    console.log("OK " + v.manifest.id + " " + v.manifest.version + "  digest " + v.digest + (v.signer ? "  signed by " + v.signer.publisher + " (" + v.signer.keyId + ")" : "  UNSIGNED"));
    v.warnings.forEach((w) => console.log("warning: " + w));
  } else if (cmd === "trust") {
    const [keyId, pubPath, publisher, ...scopes] = rest;
    if (!keyId || !pubPath || !publisher || !scopes.length) die("trust <keyId> <public.pem> <publisher> <scope>...  (scope = module id prefix such as org.example)");
    const list = [...(await trustedKeys()).values()].filter((k) => k.keyId !== keyId);
    list.push({ keyId, publisher, publicKey: await readFile(pubPath, "utf8"), scopes });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "trusted-keys.json"), JSON.stringify(list, null, 2));
    console.log("Trusting " + keyId + " (" + publisher + ") for " + scopes.join(", ") + ". Restart is not needed.");
  } else if (cmd === "inbox") {
    await ensureDirs(dir);
    const trusted = await trustedKeys();
    const registry = createRegistry({ dir, coreVersion: version });
    const packages = createPackages({ dir, registry, audit: createAudit(""), runtimes: {}, coreVersion: version, allowUnsigned: process.env.ESTAMPES_MODULE_ALLOW_UNSIGNED === "1" });
    await packages.loadKeys();
    const list = await packages.available();
    console.log(list.length ? list.map((p) => (p.error ? "BAD  " + p.file + ": " + p.error : "ok   " + p.id + " " + p.version + (p.signed ? " signed by " + p.signer : " UNSIGNED") + "  (" + p.file + ")")).join("\n") : "The inbox " + join(dir, "inbox") + " is empty. Copy *.estpkg.json files into it.");
    void trusted;
  } else if (cmd === "approve") {
    const planId = rest[0] ?? die("approve <planId>  (the id is shown in the Store's confirmation screen)");
    const { key } = await resolveAdminKey({ storageDir: storage, configured: (process.env.ESTAMPES_ADMIN_KEY ?? "").trim() });
    if (!key) die("no administrator key (is ESTAMPES_STORAGE_DIR right? is it " + storage + "?)");
    await writeApproval(storage, key, planId);
    console.log("Approved " + planId + " for 30 minutes. Now press Confirm in the Estampes Store.");
  } else if (cmd === "secret") {
    const [action, moduleId, name] = rest;
    const secrets = createSecrets({ dir });
    if (action === "set") {
      if (!MODULE_ID.test(moduleId ?? "") || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(name ?? "")) die("secret set <moduleId> <name>  (then type or pipe the value; it is not taken from the command line)");
      const chunks = []; for await (const c of process.stdin) chunks.push(c);
      const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
      if (!value) die("no value on standard input");
      await secrets.set(moduleId, name, value);
      console.log("Stored " + name + " for " + moduleId + " in " + join(dir, "secrets.json") + " (mode 600). The module itself can never read it. Alternatively set the environment variable " + envName(moduleId, name) + ".");
    } else if (action === "status") {
      if (!MODULE_ID.test(moduleId ?? "")) die("secret status <moduleId>");
      const names = [...(await readdir(join(dir, "packages", moduleId)).catch(() => [])).sort().slice(-1)];
      const manifest = names[0] ? JSON.parse(await readFile(join(dir, "packages", moduleId, names[0], "package.json"), "utf8")).manifest : null;
      for (const sec of manifest?.secrets ?? []) console.log((await secrets.has(moduleId, sec.name) ? "set      " : "NOT SET  ") + sec.name + (sec.label ? "  (" + sec.label + ")" : "") + "  env: " + envName(moduleId, sec.name));
      if (!manifest?.secrets?.length) console.log("No declared secrets for " + moduleId + " (or it is not installed).");
    } else die("secret <set|status> <moduleId> [name]");
  } else if (cmd === "init") {
    const [target, id] = rest, kind = flag("runtime") ?? "declarative";
    if (!target || !MODULE_ID.test(id ?? "") || !["declarative", "wasm", "http"].includes(kind)) die("init <dir> <id> [--runtime declarative|wasm|http]; id is reverse-DNS such as org.example.mymodule");
    const manifest = starterManifest(id, kind, version);
    await mkdir(target, { recursive: true });
    for (const name of ["module.json", "README.md"]) {
      if (await readFile(join(target, name)).then(() => true, () => false)) die(join(target, name) + " already exists; init does not overwrite your files");
    }
    await writeFile(join(target, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
    const intro = {
      declarative: "Edit `module.json`: each capability lists scene operations with `{\"$param\": \"name\"}` placeholders.\n\n",
      wasm: "Write `module.c` (or Rust/any language that targets wasm32 with no imports) following the ABI " + WASM_ABI + " in docs/MODULES.md, build `module.wasm`, then:\n\n",
      http: "Edit `module.json`: replace `api.example.org` (in `network.allow`, `network.dataFlow` and the profile) with your service, describe the `request`, map the reply with `{\"$response\": \"a.b\"}` in `response`, and paste a real reply of your service into the example's `mockResponse` so `test` checks the mapping offline. Then:\n\n",
    }[kind];
    await writeFile(join(target, "README.md"), "# " + id + "\n\n" + intro
      + "```\nnode scripts/estampes-module.js test " + join(target, "module.json") + "\nnode scripts/estampes-module.js keygen mykey\nnode scripts/estampes-module.js pack " + join(target, "module.json") + " --out " + id + ".estpkg.json --key mykey.private.pem --key-id mykey" + (kind === "wasm" ? " --file module.wasm=" + join(target, "module.wasm") : "") + "\n```\n");
    console.log("Created " + join(target, "module.json") + ". Next: node scripts/estampes-module.js test " + join(target, "module.json"));
  } else if (cmd === "test") {
    const path = rest[0] ?? die("test <module.json>");
    const manifest = validateManifest(JSON.parse(await readFile(path, "utf8")), { coreVersion: version });
    let runtime = { kind: manifest.runtime.kind };
    if (manifest.runtime.kind === "wasm") {
      const file = join(path, "..", manifest.runtime.entry);
      const bytes = await readFile(file).catch(() => die("build " + file + " first (runtime.entry)"));
      const files = { [manifest.runtime.entry]: { encoding: "base64", content: bytes.toString("base64") } };
      checkWasmPackage(manifest, files); // the same checks an install makes, even if no example runs
      runtime = { kind: "wasm", wasm: wasmFileOf(manifest, files) };
    }
    const report = await selfTest(manifest, runtime, { runtimes: { declarative: declarativeRuntime, wasm: wasmRuntime, http: createHttpRuntime({ egress: createEgress({ secrets: createSecrets({}) }) }) } });
    const count = report.examples;
    console.log("OK " + manifest.id + " " + manifest.version + ": manifest valid, " + count + " example(s) passed" + (report.mocked ? " (" + report.mocked + " with a mock response)" : "") + (count ? "" : " (no examples: add `examples` to each capability)"));
    for (const line of report.untested) console.log("warning: " + line);
  } else if (cmd === "copy") {
    const [src] = rest; await ensureDirs(dir); await copyFile(src, join(dir, "inbox", basename(src)));
    console.log("Copied into the inbox.");
  } else {
    console.log("Usage: node scripts/estampes-module.js <keygen|pack|verify|trust|inbox|copy|approve|secret|init|test> ...  (see the comment at the top of this file)");
    process.exitCode = cmd ? 1 : 0;
  }
} catch (error) { die(String(error?.message || error)); }
