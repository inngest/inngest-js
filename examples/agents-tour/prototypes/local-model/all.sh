#!/usr/bin/env bash
# Runs every candidate, one at a time, through the shared heavy gate.
cd "$(dirname "$0")/../.."
for m in "$@"; do
  /tmp/claude-1000/heavy pnpm tour:model-proto --model "$m" --runs 10 > "$LOGDIR/$m.log" 2>&1
  echo "$m exit $?" >> "$LOGDIR/all.status"
done
