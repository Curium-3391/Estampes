# Distributing modules

How a module gets from its author to a server, and what each way of doing it checks. Reference: [Modules](../MODULES.md#installing-packages), [Module quick start](QUICKSTART.md).

Status: package files, `trust`/`copy`, **package sources** (`index`, `source add/sync`) and **URL import** (`fetch`) are implemented and tested in `tests/module-sources.test.js` against a fake https host. A fetch from the real GitHub has not been run in the repository's tests. A **community index** is a design below, not implemented.

## What stays the same

Every route ends in the same place: a verified package in `<storage>/modules/inbox/`. From there nothing changed:

- the package must be signed by a key the server trusts **for that id prefix**, and is verified (digest, signature, manifest, core version, runtime, WebAssembly limits) before it is listed;
- installing needs the user's confirmation in the Store **and** the administrator's `approve <planId>`; enabling is a second plan; high-risk permissions need the administrator again;
- the examples (including http `mockResponse` fixtures) run as a self-test before a version becomes active.

The server itself never downloads anything. Sources and URL import run in the administrator's CLI (`scripts/estampes-module.js`), and module network access (`src/modules/egress.js`) is unchanged.

## The routes

| Route | Author does | Administrator does | Good for |
| --- | --- | --- | --- |
| File | `pack`, send the `.estpkg.json` and `public.pem` | `trust <keyId> <pem> <publisher> <prefix>`, `copy`, `approve` | one package, private exchange |
| URL import | `pack`, upload to a GitHub Release (or any https host), announce the sha256 | trust the key once (`trust` or a source), then `fetch <url> [--sha256 …]`, `approve` | a single release link |
| Package source | `pack` + `index`, upload both to each release | `source add` once (accept the fingerprint), then `source sync` whenever, `approve` | everything a publisher releases, updates included |

### Package sources

A source is a publisher's **index** (`estampes.index/1`), a small JSON file hosted next to their packages. It names the publisher, the ed25519 public key that signs their packages, the id prefixes (`scopes`) they publish under, and each package's file name (or https URL), version, size and digest. The index is signed by that same key.

Author, for each release:

```sh
node scripts/estampes-module.js pack mymodule/module.json --out org.example.mymodule-1.2.0.estpkg.json --key mykey.private.pem --key-id mykey
node scripts/estampes-module.js index --out estampes-index.json --key mykey.private.pem --key-id mykey \
  --publisher "Example Author" --scope org.example org.example.mymodule-1.2.0.estpkg.json [more packages…]
```

`index` refuses a package that the key did not sign or whose id is outside `--scope`, and prints the key's fingerprint (`sha256:` and 64 hex digits). Put the fingerprint in your README, where administrators can compare it. Upload `estampes-index.json` and the packages as assets of the same GitHub Release: file names in the index are resolved next to the index URL the source was added with (not the storage address GitHub redirects it to), so the stable link `https://github.com/<owner>/<repo>/releases/latest/download/estampes-index.json` always points at the newest release. Older versions can stay listed; `sync` takes the newest of each id.

Administrator, once:

```sh
node scripts/estampes-module.js source add example https://github.com/<owner>/<repo>/releases/latest/download/estampes-index.json
#   Publisher:   Example Author
#   Key:         mykey
#   Fingerprint: sha256:3735…fff5
#   May publish: org.example
#   Packages:    org.example.mymodule 1.2.0
#   estampes-module: not added yet: check this fingerprint with the publisher, then run the same command with --accept sha256:3735…fff5
node scripts/estampes-module.js source add example <same url> --accept sha256:3735…fff5 [--scope org.example.mymodule]
```

Nothing is trusted by the first command. The second one pins the key: it is added to `trusted-keys.json` for the publisher's scopes, or a narrower `--scope` you give (it cannot be wider than the index's). Then, whenever you want updates:

```sh
node scripts/estampes-module.js source sync            # or: source sync example
#   ok   example org.example.mymodule 1.2.0  -> inbox/org.example.mymodule-1.2.0.estpkg.json
```

and install from the Store as usual. `source list` shows the sources; `source remove <name>` removes one and the key it added (installed modules and inbox files are not touched).

What `sync` refuses, each reported per package while the others still arrive:

- an index signed by any key other than the pinned one (the publisher's account or release was taken over, or they rotated keys: remove the source and add it again after checking the new fingerprint with them);
- an index whose signature does not match, or that lists ids outside its own scopes;
- a package outside the scopes this server accepted, not signed by the source's key, whose size, id, version or digest differs from its index entry, or that fails any install check.

### URL import

```sh
node scripts/estampes-module.js fetch https://github.com/<owner>/<repo>/releases/download/v1.2.0/org.example.mymodule-1.2.0.estpkg.json --sha256 <hex>
```

The key must already be trusted (by `trust` or by a source); otherwise the error names the key and both ways to trust it. `--sha256` pins the exact file bytes the publisher announced (`sha256sum file.estpkg.json`), so a release asset replaced later is refused.

### Fetching rules

Both commands fetch over https only, from public addresses only (the same DNS check modules get: no loopback, private, link-local or metadata addresses), follow at most 5 redirects and only to https (GitHub release downloads redirect to a storage host), and stop at 256 KB for an index and 2 MB for a package. A local path works in place of a URL, for an administrator who downloaded the files by hand; file names inside an index cannot contain `/`, so they cannot climb out of the index's folder.

Behind a proxy that blocks direct connections, the CLI cannot fetch; download the files by hand and pass the paths.

## Design notes

Why the key is pinned on first use rather than trusted from the index: the index is hosted by the publisher, so whoever controls the hosting could put any key in it. The fingerprint comparison is the one moment a person checks it; after that, the hosting can be compromised without the server installing anything the original key did not sign. That is the same property as `trust` today, with one command instead of copying a PEM file.

Why the CLI and not the server: a server that fetches packages from configurable URLs is a new outbound path on every request the Store makes. Keeping it in the administrator's CLI means nothing new reaches the network unless the administrator runs a command.

## Planned: community index

A curated list of sources, so a user can find modules without knowing publishers first. Not implemented; the design, so that it can be built without changing the above:

- `estampes.catalog/1`: a list of `{name, url, fingerprint, scopes, summary, reviewedAt}` entries, signed by a curator key.
- The administrator adds the catalog once with the same accept-the-fingerprint step (`catalog add`), and pins the curator key.
- `catalog list` shows what is available. `source add <name> --from-catalog` copies the entry's URL and **pre-fills** the fingerprint, but still shows it and still needs `--accept`: the catalog says who it reviewed, it does not install for you.
- A catalog entry can only narrow what a source may publish (its scopes), never widen it; removing an entry from the catalog does not remove a source already added.
- "Verified" means the curator checked the publisher's identity and fingerprint and the module's permissions and data flow at `reviewedAt`, not that every later release is safe; each release is still verified and approved on the server.

Open questions before building it: who runs the curator key for the public catalog, and how a revocation (a compromised publisher) reaches servers that do not sync often.
