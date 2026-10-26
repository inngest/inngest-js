#!/bin/sh
# Cross-builds static linux binaries into ./dist and checks that they are static.
set -eu
cd "$(dirname "$0")"
mkdir -p dist
for arch in amd64 arm64; do
  out=dist/inngest-tool-linux-$arch
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags="-s -w" -o "$out" .
  echo "$out $(wc -c < "$out") bytes, $(gzip -9 -c "$out" | wc -c) gzipped"
  if command -v file >/dev/null 2>&1; then
    file "$out"
  else
    go version -m "$out" | grep -E 'CGO_ENABLED|build\s+-ldflags' || true
  fi
done
