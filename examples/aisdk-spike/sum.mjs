import fs from "node:fs";
const rows = fs.readFileSync("log.jsonl","utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
const want = process.argv[2];
const runs = [...new Set(rows.filter(r=>r.runId).map(r=>r.runId))];
const verbose = process.argv.includes("-v");
for (const runId of runs) {
  if (want && want !== "all" && !runId.includes(want) && want !== "last") continue;
  if (want === "last" && runId !== runs.at(-1)) continue;
  const rs = rows.filter(r=>r.runId===runId);
  const t0 = rs[0].at;
  const c = (t)=>rs.filter(r=>r.t===t).length;
  const invs = rs.filter(r=>r.t==="invoke").length;
  const steps = rs.filter(r=>r.t==="step");
  console.log(`run ${runId.slice(-6)} invocations=${invs} http=${c("http")} injected=${c("injected")} toolStarts=${c("tool-start")} onStepFinish=${c("onStepFinish")} onToolExecStart=${c("onToolExecutionStart")} stepReturns=${steps.length} distinctStepIds=${new Set(steps.map(s=>s.id)).size} dur=${(rs.at(-1).at-t0)}ms`);
  if (verbose) for (const r of rs) console.log("  +"+(r.at-t0), r.t, r.inv??"", r.id??r.name??"", r.hash??"", r.bytes??"", r.toolCallId?.slice(-6)??"", r.ms??"");
}
