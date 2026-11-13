# Getting help with Estampes

Estampes is a self-hosted, pre-1.0 project maintained on a best-effort basis. There is no hosted service, guaranteed support response time, or contractual support commitment.

## Where to start

- [Quick start](docs/QUICKSTART.md) and [Deployment](docs/DEPLOYMENT.md) for installation and MCP connection.
- [Troubleshooting](docs/TROUBLESHOOTING.md) for common server, canvas, image, and module issues.
- [Compatibility](docs/COMPATIBILITY.md) for tested hosts and the limits of live-host verification.
- [Module guide](docs/MODULES.md) for module permissions, packages, and extensions.
- [Backup and restore](docs/BACKUP-RESTORE.md) before upgrades, migrations, or storage troubleshooting.

## Where to ask

| Need | Best place |
| --- | --- |
| Setup, usage, or troubleshooting question | [Discussions: Q&A](https://github.com/Curium-3391/Estampes/discussions/categories/q-a) |
| General proposal or exploratory idea | [Discussions: Ideas](https://github.com/Curium-3391/Estampes/discussions/categories/ideas) |
| Reproducible bug | [New Issue](https://github.com/Curium-3391/Estampes/issues/new/choose) |
| Concrete feature or module proposal | [New Issue](https://github.com/Curium-3391/Estampes/issues/new/choose) |
| Security vulnerability | [Security policy](SECURITY.md) — report privately, not in a public issue |
| Code contribution | [Contributing](CONTRIBUTING.md) |

For a reproducible bug, mention the Estampes version (from `/version`), host/client, operating environment, reproduction steps, expected versus observed behavior, and **sanitized** diagnostic output. Do not paste the `?key=` query parameter, access or admin keys, module credentials, personal images, or private volume contents.

For suspected bugs involving data loss or persistence, keep a backup of your data and do not publish the backup. The latest released version is the supported version; see [SECURITY.md](SECURITY.md).

Automated tests, fake-host browser tests, and live ChatGPT/Claude compatibility are different kinds of evidence; please say which one your report covers.
