#!/bin/sh
# Installs the pinned XcodeGen release (checksum-verified) into ./.tools and
# prints the binary's path. Xcode Cloud (ci_scripts/ci_post_clone.sh) and GitHub
# CI (.github/workflows/ios.yml) both use it, so every build generates the
# project with the same XcodeGen. Homebrew would install whatever is newest.
#
# To upgrade: change VERSION and SHA256 (from the release asset's digest,
# `gh api repos/yonaskolb/XcodeGen/releases/tags/<version>`), then regenerate.
set -eu

VERSION=2.45.4
SHA256=090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef

here=$(cd "$(dirname "$0")/.." && pwd)
dest="$here/.tools/xcodegen-$VERSION"
bin="$dest/xcodegen/bin/xcodegen"

if [ ! -x "$bin" ]; then
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/xcodegen.zip" \
    "https://github.com/yonaskolb/XcodeGen/releases/download/$VERSION/xcodegen.zip"
  echo "$SHA256  $tmp/xcodegen.zip" | shasum -a 256 -c - >&2
  mkdir -p "$dest"
  unzip -q "$tmp/xcodegen.zip" -d "$dest"
  rm -rf "$tmp"
fi

got=$("$bin" --version | sed 's/^Version: //')
if [ "$got" != "$VERSION" ]; then
  echo "error: expected XcodeGen $VERSION, got $got" >&2
  exit 1
fi
echo "$bin"
