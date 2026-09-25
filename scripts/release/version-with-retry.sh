#!/bin/bash
set -e

MAX_RETRIES=3
RETRY_DELAY=10

for i in $(seq 1 $MAX_RETRIES); do
  echo "Attempt $i of $MAX_RETRIES..."
  if pnpm run release:version; then
    echo "Version succeeded on attempt $i"
    exit 0
  fi
  if [ $i -lt $MAX_RETRIES ]; then
    echo "Attempt $i failed, retrying in ${RETRY_DELAY}s..."
    sleep $RETRY_DELAY
    RETRY_DELAY=$((RETRY_DELAY * 2))
  fi
done

echo "All $MAX_RETRIES attempts failed"
exit 1
