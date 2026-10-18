# CI/CD and releases

The repository builds, tests and releases on **GitHub Actions** and on **GitLab CI**. They are twins: the same checks
and the same release, with the host's own publishing at the end. Everything that is not host-specific lives in scripts,
so the two files stay thin: `scripts/version.ts` (version and changelog), `deploy/image-test.sh` and `deploy/smoke.sh`
(image and stack), `apps/cli/release.ts` (binaries).

| | GitHub Actions | GitLab CI |
|---|---|---|
| Config | `.github/workflows/ci.yml`, `release.yml` | `.gitlab-ci.yml` |
| Check (typecheck, lint, test) | `check` | `check` |
| Dependency advisories | `audit` | `audit` |
| Image build + test, self-host smoke | `image` | `image-test` |
| Browser journey (Playwright) | `e2e` | `e2e` |
| Next version preview | `release-preview` | `release-preview` |
| Cut a release | run **Release** (Actions tab) | run `release-cut` (manual job on `main`) |
| Binaries and `SHA256SUMS` | GitHub release assets | generic package registry (`release` job) |
| Image | `ghcr.io/<owner>/<repo>` | the project's container registry |

## Versions

Semantic versioning, decided by the commit messages since the last `v*` tag (Conventional Commits):

| Commit | Release |
|---|---|
| `feat!:` / `fix!:` / a `BREAKING CHANGE:` footer | major (**minor while below 1.0.0**: going to 1.0.0 is a decision, not an accident) |
| `feat:` | minor |
| `fix:`, `perf:`, `revert:` | patch |
| `docs:`, `chore:`, `test:`, `ci:`, `refactor:`, `style:`, `build:` (and anything that is not a conventional commit) | none |

Land changes with **rebase or fast-forward merges**, not merge commits or squashes that rewrite the message, or the
commit messages the rules read are lost. `bun scripts/version.ts` prints the next version (nothing if no commit
releases); `--notes FILE` writes its release notes; `--apply` also sets the version in `apps/cli/package.json` (what
the binary reports) and `bun.lock`, and prepends `CHANGELOG.md`. It never commits or tags.

## Releasing

Releasing is a click, not a side effect of every merge: **publishing is a human gate** (OPS-6). Both hosts do the
same things in the same order, and everything before the commit is a dry run that publishes nothing.

1. Compute the version and changelog. Nothing to release: stop.
2. Build the four binaries and `SHA256SUMS`; build the image and run `deploy/image-test.sh` on it.
3. Only when publishing: commit `chore(release): vX.Y.Z` (version files and changelog), create the tag `vX.Y.Z` on it and
   push both together. This is the one step that cannot be taken back.
4. Then, from that tag: push the image (`X.Y.Z`, `X.Y`, `latest`) and publish the binaries.

**GitHub:** Actions > Release > Run workflow; leave *Publish* off for the dry run (the binaries are in the run's
artifacts and the changelog in its summary), switch it on to publish. Publishing is refused unless the run is on the
default branch and CI passed on that exact commit. Two jobs: `release` (steps 1-3, can write the repository) and `publish`
(step 4, can write packages and the release). If `publish` fails, *Re-run failed jobs*: running the whole workflow again
finds nothing to release, the tag is already there. A protected default branch must let `github-actions[bot]` push.
**GitLab:** the `release-cut` manual job on `main` (it waits for `check` and `image-test`) runs steps 1-3 with
`RELEASE_PUBLISH=true` set on that run; without it, it is the dry run. It needs a `RELEASE_TOKEN` CI variable (a project
access token with `write_repository`, masked and protected) to push the commit and tag; the token reaches git through the
environment, never the command line. The tag pipeline then runs `release` (binaries) and `image-publish` (step 4).

To make releases automatic, run the same job on every push to `main` instead of by hand; the rules above already
decide whether anything is released.

## Installing a release

`apps/cli/install.sh` downloads from a directory that holds `orch-<os>-<arch>` and `SHA256SUMS`: a GitHub release
(`https://github.com/<owner>/<repo>/releases/download/vX.Y.Z`) or a GitLab package
(`https://<gitlab>/api/v4/projects/<id>/packages/generic/orch/vX.Y.Z`). See [install.md](install.md).

## Verified, and not

**GitHub:** `check`, `audit`, `e2e`, `image` (the image test and the self-host smoke) and `release-preview` have run
green on a real pull request. The **Release** workflow has not run yet: neither the dry run nor a publish (it was
restructured into two jobs after that). Run the dry run first and read its summary and artifacts.

**GitLab:** `.gitlab-ci.yml` has not run on a real GitLab: there is no GitLab project for this repository yet (FND-6),
and nothing here can lint it beyond parsing the YAML. Push it to one and read the first pipeline before trusting it. The
parts most likely to need a fix are the ones that differ from GitHub: the Docker-in-Docker jobs (`image-test`,
`release-cut`, `image-publish`), the `e2e` job (Microsoft's Playwright image plus Bun from npm) and the `RELEASE_TOKEN`
push.

**One difference to know:** the backup and restore tests need the Postgres 18 client. The GitHub `check` job installs
it, so they run there; GitLab's `oven/bun` image has none, so they are skipped there.
