#!/bin/bash
# usage: crash.sh '<event data json>' <kill when tool.start count reaches N> [event name]
cd "$(dirname "$0")"
DS=~/repo/inngest/devstack/bin/devstack
rm -rf data/evidence.jsonl data/sessions
touch data/evidence.jsonl
$DS send ${3:-spike/a1b} --stack agsdk --data "$1" --timeout 1s >/dev/null 2>&1 &
count() { grep -c "\"kind\":\"tool.start\"" data/evidence.jsonl || true; }
until [ "$(count)" -ge "$2" ]; do sleep 0.3; done
sleep 1
echo "RESTART at $(date +%T)"
$DS restart agsdk/agsdk 2>&1 | tail -1
for i in $(seq 1 80); do
  if grep -q '"kind":"turn.end".*"subtype":"success"' data/evidence.jsonl 2>/dev/null; then break; fi; sleep 2
done
sleep 4
node summarize.mjs
