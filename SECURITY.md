# Security policy

## Reporting a vulnerability

Please report security problems **privately**. Do not open a public issue or pull request with details.

Use GitHub's private vulnerability reporting: on the repository page open **Security → Report a vulnerability**. If that button is missing (the owner may not have switched the feature on), open a public issue that says only "I have a security report, please enable a private channel" and contains no technical details; the maintainer will answer with a way to send it.

Include the Estampes version (`/version`), how you run it (Docker, Node, Heroku, Render), what you did, what you expected and what happened. If you can, say whether the problem needs the access key or works without it.

This is a volunteer-run, pre-1.0 project. There is no service-level promise; reports are read and answered on a best-effort basis, and a fix ships as a normal patch release described in the [changelog](CHANGELOG.md).

## What is supported

Only the latest released version receives fixes. Older versions are not patched; upgrade ([Releasing](docs/RELEASE.md), [Backup and restore](docs/BACKUP-RESTORE.md)).

## Security model in one page

Estampes is **self-hosted and single-owner**: one person runs one instance for their own use. It is not a multi-user service.

| Topic | How it works | What it does not give you |
| --- | --- | --- |
| Access | One shared **access key** gates `/mcp` and `/api/v1/*`. In Docker it is generated into `/data/access-key` on first start. ChatGPT is connected with the key inside the URL (`?key=`). | It is a bearer secret in a URL, not per-user authentication. Anyone who has the URL can use the server and see every stored image. There are no user accounts, roles or per-image permissions. |
| Open mode | `ESTAMPES_ALLOW_OPEN=1` runs without a key. | Use only on closed networks. |
| Download links | Image and SVG export links are signed (`?sig=`) from the key. | Without a key they are protected only by the image hash. |
| Network exposure | Docker publishes on `127.0.0.1` by default. `ESTAMPES_BIND=0.0.0.0` opens it to the network. Forwarded headers are trusted only with `ESTAMPES_TRUST_PROXY`. Requests are rate-limited per client address on `/mcp`. | A temporary Cloudflare tunnel puts the server on the public internet; only the key protects it, and the key is printed in the container log. |
| Reading external images | When GPT gives an image URL, the server fetches it itself: https only, no credentials in the URL, the host must resolve to a **public** address, redirects are limited, size and pixel caps apply. | It is still a server making requests on a stranger-influenced URL. Do not run Estampes with access to internal services you cannot afford to expose, and keep it in an isolated network where possible. |
| Modules | A module can only do what its manifest asks for and you approved in the Store. Enabling is a plan you confirm; the consent token goes only to the Store widget, never to the model. Installing or updating a package also needs the **administrator** to approve on the server (`scripts/estampes-module.js approve`). Unsigned packages are refused unless `ESTAMPES_MODULE_ALLOW_UNSIGNED=1`. | A module with network permission can send what its manifest says it sends (for example plate solving uploads your image to Astrometry.net). Read the permission screen. |
| Module network | Every request goes through one egress point: https, port 443, exact host names from the manifest, no redirects, secrets added by the server and never visible to module code. | Approving a host trusts that host with the data described. |
| Calculator | SymPy runs in a separate container: no network, read-only filesystem, no capabilities, reachable only through a Unix socket. | Heavy expressions can still use CPU up to the container's limits (2 CPUs, 2 GB). |
| Container | The main container runs as an unprivileged user with a read-only filesystem except `/data` and `/tmp`, no capabilities and `no-new-privileges`. | Your host, Docker and the volume's permissions are yours to secure. |
| Persistence | With storage on, images, marks, history, module state and notebooks are plain files in `/data`. | Nothing is encrypted at rest. Anyone who can read the volume or a backup reads everything, including the keys. |

Details and the full list of settings: [Deployment](docs/DEPLOYMENT.md#caveats), [Modules](docs/MODULES.md), [Architecture](docs/ARCHITECTURE.md#security-model).

## Keys, leaks and rotation

See [Backup and restore → Keys and secrets](docs/BACKUP-RESTORE.md#keys-and-secrets) for the step-by-step response to a leaked access key, administrator key or module secret.

## Out of scope

Reports about the deliberate single-owner design (for example "the key is in the URL", "anyone with the key can see all images") are known limitations, documented above. Reports of ways to bypass the key, read data without it, escape the container or module sandbox, make the server fetch non-public addresses, or approve a module change without the user or administrator are in scope.
