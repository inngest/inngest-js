#!/usr/bin/env bash
# Run one suite pipeline on the local Dev Server + Cloud Sandboxes, then print its
# trace summary.
#
#   INNGEST_CI_DEV_SERVER_BIN=<dev server binary> scripts/run.sh <pipeline> [label]
#
# Extra env (E2E_APP_ID, E2E_BAD, ...) passes through to the app. Logs go to
# $E2E_LOGS (default /tmp/ci-e2e-logs). Exit status is the CLI's.
set -u

pipeline="$1"
label="${2:-$pipeline}"
logs="${E2E_LOGS:-/tmp/ci-e2e-logs}"
here="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$logs"
cd "$here"

start=$(date +%s)

BROWSER=true timeout "${E2E_TIMEOUT:-600}" npx inngest-ci "$pipeline" \
  --event "ci/manual.$pipeline" --data "${E2E_DATA:-{\}}" --no-interactive \
  > "$logs/$label.log" 2>&1
code=$?

end=$(date +%s)

runId=$(grep -m1 -oE 'inngest-ci open [0-9A-Z]{26}' "$logs/$label.log" | awk '{print $3}')

echo "== $label: exit=$code wall=$((end - start))s run=${runId:-none}"
grep -E '^(passed|failed|cancelled)|^warning|^error|CiUsageError|Error:' "$logs/$label.log" | head -12

if [ -n "$runId" ] && [ -z "${E2E_NO_TRACE:-}" ]; then
  npx inngest-ci open "$runId" > "$logs/$label.open.log" 2>&1 &
  openPid=$!

  for _ in $(seq 1 30); do
    port=$(grep -m1 -oE '127\.0\.0\.1:[0-9]+' "$logs/$label.open.log" | cut -d: -f2)
    [ -n "$port" ] && break
    sleep 1
  done

  if [ -n "${port:-}" ]; then
    node scripts/trace.mjs "$port" "$runId" --tree > "$logs/$label.trace.txt" 2>&1
    tail -n 9 "$logs/$label.trace.txt"
  fi

  kill "$openPid" 2>/dev/null
  wait "$openPid" 2>/dev/null
fi

exit "$code"
