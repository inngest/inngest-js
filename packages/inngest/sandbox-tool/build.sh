#!/bin/sh
# Cross-builds the static linux binaries into ./dist and checks that they are static.
# With --package, also copies the amd64 build into ../dist/sandbox-tool/dist so the published
# package carries it. Without Go, --package keeps an existing build or warns and succeeds, so a
# build machine without Go still builds the SDK; handler shims then report a missing binary.
set -eu
cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
  if [ "${1:-}" = "--package" ]; then
    echo "sandbox-tool: go not found; handler shims will report a missing binary" >&2
    # A CI build must not publish a package without the binary.
    [ -z "${CI:-}" ] || [ -f dist/inngest-tool-linux-amd64 ] || exit 1
    [ -f dist/inngest-tool-linux-amd64 ] || exit 0
  else
    echo "sandbox-tool: go not found" >&2
    exit 1
  fi
else
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
fi

if [ "${1:-}" = "--package" ]; then
  mkdir -p ../dist/sandbox-tool/dist
  cp dist/inngest-tool-linux-amd64 ../dist/sandbox-tool/dist/
fi
