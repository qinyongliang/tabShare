#!/usr/bin/env bash
set -euo pipefail
tools_dir=/workspace/.tabshare-tools
mkdir -p "$tools_dir"
if ! "$tools_dir/go/bin/go" version 2>/dev/null | rg -q 'go1\.27\.2 '; then
  archive=$(mktemp /tmp/tabshare-go.XXXXXX.tar.gz)
  curl --fail --silent --show-error --location https://go.dev/dl/go1.27.2.linux-amd64.tar.gz -o "$archive"
  printf '%s  %s\n' 'ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5' "$archive" | sha256sum -c -
  tar -xzf "$archive" -C "$tools_dir"
  rm "$archive"
fi
export PATH="$tools_dir/go/bin:$PATH"
export GOPATH="$tools_dir/gopath" GOMODCACHE="$tools_dir/mod" GOCACHE="$tools_dir/cache"
cd /workspace/tabShare
go mod download
npm ci --ignore-scripts --cache "$tools_dir/npm-cache"
go build -o bin/tabshare ./cmd/tabshare
