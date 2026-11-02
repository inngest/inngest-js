#!/usr/bin/env bash
# The prefix-cache comparison, then gemma-4-e2b, one at a time at 2 threads.
cd "$(dirname "$0")/../.."
pnpm tour:model-proto --model qwen3-1.7b --runs 5 --threads 2 --no-cache --scenarios answer,tool --tag t2-nocache > "$LOGDIR/nocache.log" 2>&1
echo "nocache exit $?" >> "$LOGDIR/rest.status"
pnpm tour:model-proto --model gemma-4-e2b --runs 5 --threads 2 --tag t2 > "$LOGDIR/gemma-4-e2b.log" 2>&1
echo "gemma exit $?" >> "$LOGDIR/rest.status"
