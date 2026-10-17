# Installing the `orch` binary

A tag like `v1.2.3` runs the `release` job in `.gitlab-ci.yml`. It builds `orch` for macOS and Linux
(arm64 and x64), writes `SHA256SUMS`, and uploads all five files to the project's generic package
registry (`packages/generic/orch/<tag>/`).

## Install

```sh
export ORCH_RELEASE_URL=https://gitlab.example.com/api/v4/projects/<id>/packages/generic/orch/v1.2.3
sh install.sh            # apps/cli/install.sh; ORCH_INSTALL_DIR=... to change $HOME/.local/bin
```

`install.sh` downloads `SHA256SUMS` and the binary for this machine, and installs only when the binary's
SHA-256 matches its entry. A missing, malformed or repeated entry, a mismatch or a failed download
installs nothing and leaves any earlier `orch` alone. It needs `https` (`ORCH_ALLOW_HTTP=1` is for
tests), `curl`, and `sha256sum` or `shasum`.

A private project's registry refuses anonymous downloads: copy the five files to somewhere the machine
can read and point `ORCH_RELEASE_URL` there.

## What the check proves

`SHA256SUMS` comes from the same place as the binary. The check catches a corrupt download or a swapped
binary; it does not catch a release that was replaced together with its list. Signing the list (cosign
or minisign) is the upgrade when that matters.

## Verified, and not

`bun apps/cli/release.ts <dir>` built all four binaries and a `SHA256SUMS` that `shasum -c` accepts on a
macOS laptop, and `install.sh` is tested against a local server (tampered, missing, malformed and
repeated entries, redirects, signals). The `release` job and the registry upload have not run on a real
GitLab pipeline: the first `v*` tag is the test. Check that four binaries and `SHA256SUMS` appear in the
package registry, and that `install.sh` accepts them. Running the job again for a tag that was already
uploaded adds duplicate files to the package: use a new version instead.
