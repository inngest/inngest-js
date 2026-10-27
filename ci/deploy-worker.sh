#!/usr/bin/env bash
# Deploys the always-on inngest-js CI worker to the Fly app inngest-js-ci.
# Run from anywhere inside the repository. Nothing is built locally: Fly builds the image.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "jack/ci-worker" ]; then
  echo "On $branch; check out jack/ci-worker first." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "The worktree has uncommitted changes; commit or stash them first." >&2
  exit 1
fi

git fetch origin jack/ci-worker
sha="$(git rev-parse HEAD)"
if [ "$sha" != "$(git rev-parse origin/jack/ci-worker)" ]; then
  echo "jack/ci-worker differs from origin/jack/ci-worker; push or pull first." >&2
  exit 1
fi

read -r -p "Deploy ${sha:0:8} to inngest-js-ci? [y/N] " answer
if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
  echo "Not deployed."
  exit 1
fi

, flyctl deploy --app inngest-js-ci --config ci/fly.toml --dockerfile ci/Dockerfile --ignorefile ci/Dockerfile.dockerignore --ha=false

echo
echo "Deployed ${sha:0:8}. Open the Production dashboard and confirm inngest-js-ci is connected"
echo "with the new agents pipeline functions (the agents pipeline and its agent-checks and agent-scenarios jobs)."
