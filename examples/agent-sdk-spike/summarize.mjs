import { readFileSync } from "node:fs";
const f = process.argv[2] ?? "data/evidence.jsonl";
const ev = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const t0 = ev[0]?.t ?? 0;
const c = {};
for (const e of ev) c[e.kind] = (c[e.kind] ?? 0) + 1;
console.log(JSON.stringify(c));
for (const e of ev) {
  if (["store.append", "canUseTool.x"].includes(e.kind)) continue;
  const extra = e.kind === "turn.end" ? `${e.subtype} calls=${(e.toolCalls ?? []).join("+")} cost=${e.costUsd?.toFixed?.(5)}` : e.kind === "tool.start" || e.kind === "tool.end" ? `${e.tool} ${JSON.stringify(e.args)}` : e.kind.startsWith("store.load") ? `n=${e.n} found=${e.found}` : e.kind === "turn.start" ? `run=${e.runId?.slice(-6)} turn=${e.turn}` : e.kind === "fn.invoke" ? `run=${e.runId?.slice(-6)}` : JSON.stringify(e).slice(0, 120);
  console.log(`+${((e.t - t0) / 1000).toFixed(1).padStart(5)}s pid=${e.pid} ${e.kind.padEnd(12)} ${extra}`);
}
