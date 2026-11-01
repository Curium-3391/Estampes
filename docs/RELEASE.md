# Releasing

How a version of Estampes is released, which Docker image tags that produces, and how to check, repeat or undo a release. Only maintainers need this page; to run Estampes see [Deployment](DEPLOYMENT.md).

Status of this page: the steps and the check script were run locally. A real tag push, the GitHub Actions run it starts and the GHCR package settings were **not** exercised while writing it; those parts follow the workflow file and GitHub's documented behaviour and are marked as such.

## What triggers what

| Event | Workflow | What runs |
| --- | --- | --- |
| Push or pull request that changes code | `m0.yml` | `node-tests`, `cas-tests` (skipped when only `*.md` or `docs/**` change) |
| Pull request or push to a branch | `docker.yml` | Nothing. No Docker build, no image. |
| Push of a tag `v*` | `docker.yml` | `verify` (release check) → `smoke` (compose stack) → `image` (multi-arch build and publish) |

Pushing a tag also runs `m0.yml`, because its `push` trigger has no tag filter. That is cheap compared with the image build.

## Image tags

A tag `vX.Y.Z` publishes `ghcr.io/<owner>/estampes` for `linux/amd64` and `linux/arm64` with these tags:

| Tag | Meaning | Published for |
| --- | --- | --- |
| `X.Y.Z` | That release | every `v*` tag |
| `latest` | The newest stable release | tags without a `-` (so not `v1.0.0-rc.1`) |
| `sha-<short>` | The commit the tag points to | every `v*` tag |

There is no image for `main` and no `X.Y` or `X` tag. `latest` moves only when a stable version tag is pushed, so it is never ahead of a released version. For anything you need to reproduce, pin `X.Y.Z`.

(Before this page the workflow tried to tag `latest` only on the default branch, which a tag push never is, so `latest` was never produced. The workflow now enables it for stable version tags.)

## Release order

1. Start from an up-to-date `main` with green CI.
2. Bump `version` in `package.json` and run `npm install` so `package-lock.json` follows.
3. In `server.js`, add the previous version's URI tag (for 0.19.5 → 0.19.6, `v0195`) to `LEGACY_VISUAL_URIS` and `LEGACY_EVIDENCE_URIS`, so saved conversations keep resolving. The widget URI contains the version, which is how a release invalidates ChatGPT's cached copy.
4. In `CHANGELOG.md`, rename `## Unreleased` content into a `## X.Y.Z — title` section at the top, and keep an empty `## Unreleased` above it if you like.
5. Run the checks (below), open a pull request, merge it.
6. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The repository has no tags yet; `package.json` history is the record of past versions.

## Check before you tag

```sh
npm run release:check          # or: node scripts/check-release.mjs vX.Y.Z
npm test
docker compose config -q       # compose file parses (needs Docker)
```

`release:check` needs no network and no Docker. It fails when:

- `package.json` and `package-lock.json` disagree,
- the newest `## X.Y.Z` heading in `CHANGELOG.md` is not the package version,
- the previous release's URI tag is missing from `LEGACY_VISUAL_URIS`, or the current one is already listed,
- a tag argument is given and is not `v<package version>`,
- `docker.yml` could be triggered by anything other than a pushed `v*` tag, or still relies on `is_default_branch`.

It prints the tags a push would publish. The same script runs as the first job of the release workflow, so a mismatched tag stops before the expensive build. It does not run the Docker build itself; the `smoke` job does that after the tag is pushed.

## If a release fails

| Where it failed | What to do |
| --- | --- |
| `verify` | Nothing was built. Fix the cause on `main`, delete the remote tag (`git push origin :refs/tags/vX.Y.Z`; `git tag -d vX.Y.Z`) and tag the new merge commit. |
| `smoke` | Same: no image was published. Read the job log (`docker compose logs` is printed at the end), fix on `main`, re-tag. |
| `image` (build or push) | Re-run the failed job once in the Actions tab. If it fails again, treat it like `smoke`. |
| Found after publishing | Never move a tag that already has an image. Fix on `main` and release the next patch version. |

## Roll back

A tag is not rolled back; users move to an earlier image.

1. Back up the data volume first ([Deployment](DEPLOYMENT.md#details)).
2. Point `compose.yaml` at the earlier version, for example `image: ghcr.io/<owner>/estampes:0.19.4`, and run `docker compose up -d`.
3. Do **not** run `docker compose down -v`; that deletes the data volume.

Estampes is pre-1.0 and stored formats can change between versions, so an older release may not read data written by a newer one. Restoring the backup from step 1 is the safe way back.

## Who can pull the image

A GHCR package has its own visibility, separate from the repository's. According to GitHub's documentation, a package published for the first time is private until its owner changes the visibility in the package settings; anonymous `docker pull` works only for public packages. A private package needs `docker login ghcr.io` with a token that has `read:packages`. Whether the Estampes package is currently public has not been checked from this repository's tooling, so confirm it with an anonymous pull on a machine that is not logged in to GHCR before you advertise the image.

Without a public package, build locally with `docker compose up -d --build`; that path does not depend on GHCR.
