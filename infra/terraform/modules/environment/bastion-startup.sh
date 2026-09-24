#!/usr/bin/env bash
# Startup script for the in-VPC proof VM (bastion.tf). Idempotent: it runs on
# every boot, and skips anything already installed.
# Installs the Postgres client, git and jq (Debian), and Node 24 from the
# official nodejs.org build, verified against its SHASUMS256.txt.
set -euo pipefail
exec > >(logger -t bastion-startup) 2>&1

if ! command -v psql >/dev/null || ! command -v jq >/dev/null || ! command -v git >/dev/null; then
  apt-get update -y
  apt-get install -y --no-install-recommends postgresql-client jq git ca-certificates curl xz-utils
fi

if ! command -v node >/dev/null || ! node --version | grep -q '^v24\.'; then
  base="https://nodejs.org/dist/latest-v24.x"
  tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  tarball=$(grep -oE 'node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' "$tmp/SHASUMS256.txt" | head -1)
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1
  rm -rf "$tmp"
fi

echo "bastion-startup: ready ($(psql --version), node $(node --version))"
