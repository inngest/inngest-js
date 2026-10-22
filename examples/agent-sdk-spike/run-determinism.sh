#!/bin/bash
cd "$(dirname "$0")"
set -a; . /home/nixos/repo/demos/slack-box/.env; set +a
export ANTHROPIC_BASE_URL_OVERRIDE=http://127.0.0.1:8799
for mode in 1 none; do
rm -rf data /tmp/probe1/*; SID=$(node -e 'console.log(crypto.randomUUID())')
npx tsx explore3.ts t1 $SID $mode 2>&1 | grep -v '^`' | tail -2
cp data/sessions/$SID.jsonl /tmp/snap-$mode.jsonl
npx tsx explore3.ts t2 $SID $mode 2>&1 | grep -v '^`'| tail -1
cp /tmp/snap-$mode.jsonl data/sessions/$SID.jsonl; sleep 3
npx tsx explore3.ts t2 $SID $mode 2>&1 | grep -v '^`'| tail -1
rm -rf /tmp/probe-$mode; mkdir -p /tmp/probe-$mode; cp /tmp/probe1/* /tmp/probe-$mode/; ls /tmp/probe-$mode | grep req
done
echo ALLDONE
