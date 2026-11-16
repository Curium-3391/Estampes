# Releasing

How a version of Estampes is released, which Docker image tags that produces, and how to check, repeat or undo a release. Only maintainers need this page; to run Estampes see [Deployment](DEPLOYMENT.md).

## What triggers what

| Event | Workflow | What runs |
| --- | --- | --- |
| PR to `main` or merge queue | `pr-baseline.yml` | Stable `baseline` check with a docs, fast, or full tier |
| Weekly on Monday at 03:23 UTC or manual dispatch | `m0.yml` | Full validation of the selected ref |
| Push to `main` or manual dispatch on `main` | `docker.yml` | Full validation and Compose smoke test → build and publish Edge |
| Push of a tag `v*` | `docker.yml` | Release metadata and main ancestry check → full validation and Compose smoke test → build and publish release |

The required PR `baseline` check gates merges. The Docker workflow runs the full suite and smoke test again on the exact commit it will build. Pull requests and manual dispatches on any other ref cannot publish.

## Image tags

Images are built for `linux/amd64` and `linux/arm64` at `ghcr.io/curium-3391/estampes`.

| Tag | Published for |
| --- | --- |
| `edge` and `sha-<full-commit-sha>` | Successful Edge build from `main` |
| `X.Y.Z` and `sha-<short>` | Validated `vX.Y.Z` tag push (prereleases include their suffix) |
| `latest` | Validated stable `vX.Y.Z` tag push |

## Publish Edge manually

In **Actions → Docker image → Run workflow**, choose **main**. This runs the same tests and smoke check as an automatic Edge build. Before starting an Edge image build, the publish job checks that the validated commit is still the head of `main`. Dispatch again on `main` if the run skipped publication because the branch advanced. See [Deploy the Edge test instance](DEPLOYMENT.md#deploy-the-edge-test-instance) for tester commands.

## Release order

1. Start from an up-to-date `main` with green CI.
2. Bump `version` in `package.json` and run `npm install` so `package-lock.json` follows.
3. In `server.js`, add the previous version's URI tag (for 0.19.5 → 0.19.6, `v0195`) to `LEGACY_VISUAL_URIS` and `LEGACY_EVIDENCE_URIS`, so saved conversations keep resolving. The widget URI contains the version, which is how a release invalidates ChatGPT's cached copy.
4. In `CHANGELOG.md`, rename `## Unreleased` content into a `## X.Y.Z — title` section at the top, and keep an empty `## Unreleased` above it if you like.
5. Run the checks (below), open a pull request, merge it.
6. Run **Full validation** from the Actions tab on `main` after merging. Confirm it passed for the exact commit you intend to tag. The tag workflow repeats full validation on that commit before it can publish.
7. Tag that validated commit on `main` and push the tag:

   ```sh
   git tag vX.Y.Z <validated-commit-sha>
   git push origin vX.Y.Z
   ```

## Check before you tag

```sh
npm run release:check          # or: node scripts/check-release.mjs vX.Y.Z
npm test
docker compose config -q       # compose file parses (needs Docker)
```

`release:check` needs no network and no Docker. It fails when:

- `package.json` and `package-lock.json` disagree,
- the newest `## X.Y.Z` heading in `CHANGELOG.md` is not the package version,
- the previous release's URI tag is missing from `LEGACY_VISUAL_URIS` or `LEGACY_EVIDENCE_URIS`, or the current one is already listed,
- a tag argument is given and does not match `v<package version>`.

It prints the tags a push would publish. The same script runs as the first job of the release workflow, so a mismatched tag stops before the expensive build. It does not run the Docker build itself; the `smoke` job does that after the tag is pushed.

## If a release fails

| Where it failed | What to do |
| --- | --- |
| `verify` | Fix the cause on `main`. Release tags are protected against deletion and movement. If the fix needs a new commit, prepare a new version tag. |
| Full validation or `smoke` | Read the failed job log. Retry transient failures. For code fixes, validate the fix on `main` and prepare a new version tag. |
| `image` (build or push) | Re-run the failed job once in the Actions tab. If it fails again, treat it like `smoke`. |
| Found after publishing | Never move a tag that already has an image. Fix on `main` and release the next patch version. |

## Roll back

A tag is not rolled back; users move to an earlier image.

1. Back up the application data and UVA volumes first ([Deployment](DEPLOYMENT.md#details)).
2. Point `compose.yaml` at the earlier version, for example `image: ghcr.io/<owner>/estampes:0.19.4`, and run `docker compose up -d`.
3. Do **not** run `docker compose down -v`; that deletes the data volume.

Estampes is pre-1.0 and stored formats can change between versions, so an older release may not read data written by a newer one. Restoring the backup from step 1 is the safe way back.

## Who can pull the image

A GHCR package has its own visibility, separate from the repository's. According to GitHub's documentation, a package published for the first time is private until its owner changes the visibility in the package settings; anonymous `docker pull` works only for public packages. A private package needs `docker login ghcr.io` with a token that has `read:packages`. Whether the Estampes package is currently public has not been checked from this repository's tooling, so confirm it with an anonymous pull on a machine that is not logged in to GHCR before you advertise the image.

Without a public package, build locally with `docker compose up -d --build`; that path does not depend on GHCR.
