#!/bin/sh
# Installs the orch CLI. It downloads the binary for this machine from ORCH_RELEASE_URL (the
# directory that holds orch-<os>-<arch> and SHA256SUMS), checks it against SHA256SUMS, and only then
# puts it in ORCH_INSTALL_DIR (default ~/.local/bin). A binary that does not match is never installed.
#
# shortcut: SHA256SUMS comes from the same place as the binary, so this catches a corrupted or
# swapped file, not a compromised release; sign the list when that matters.
set -eu

die() {
  echo "install: $*" >&2
  exit 1
}

base=${ORCH_RELEASE_URL:-}
[ -n "$base" ] || die "set ORCH_RELEASE_URL to the release's download URL"
base=${base%/}
proto='=https'
case $base in
  https://*) ;;
  http://*)
    [ "${ORCH_ALLOW_HTTP:-}" = 1 ] || die "ORCH_RELEASE_URL must be an https URL"
    proto='=https,http'
    ;;
  *) die "ORCH_RELEASE_URL must be an https URL" ;;
esac

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported system: $(uname -s)" ;;
esac
case $(uname -m) in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported processor: $(uname -m)" ;;
esac
name=orch-$os-$arch
dir=${ORCH_INSTALL_DIR:-${HOME:?set HOME or ORCH_INSTALL_DIR}/.local/bin}

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  die "needs sha256sum or shasum to check the download"
fi

# a template, because BSD `mktemp -d` ignores TMPDIR without one
tmp=$(mktemp -d "${TMPDIR:-/tmp}/orch-install.XXXXXX")
staged=
trap 'rm -rf "$tmp"; [ -z "$staged" ] || rm -f "$staged"' EXIT
# dash does not run the EXIT trap when a signal ends the script, so turn signals into an exit
trap 'exit 1' INT TERM HUP

fetch() {
  curl --fail --silent --show-error --location --max-time 300 \
    --proto "$proto" --proto-redir '=https' --output "$2" "$1" || die "could not download $1"
}
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
fetch "$base/$name" "$tmp/$name"

want=$(awk -v n="$name" '$2 == n { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "SHA256SUMS has no entry for $name"
case $want in
  *[!0-9a-f]*) die "SHA256SUMS has a malformed or repeated entry for $name" ;;
esac
[ ${#want} -eq 64 ] || die "SHA256SUMS has a malformed entry for $name"
got=$(digest "$tmp/$name")
[ "$got" = "$want" ] || die "checksum mismatch for $name (expected $want, got $got): not installing"

mkdir -p "$dir"
staged=$dir/.orch.$$
cp "$tmp/$name" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$dir/orch"
staged=
echo "installed orch to $dir/orch"
case ":${PATH:-}:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on your PATH" >&2 ;;
esac
