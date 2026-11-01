/**
 * @module
 * Prints the first failing run of each scenario per result file, and the
 * tally of failure notes. Throwaway prototype.
 */
import { readdirSync, readFileSync } from "node:fs";

import type { Run } from "./scenarios.ts";

const dir = `${import.meta.dirname}/results`;

for (const name of readdirSync(dir).filter((f) => f.endsWith("t2.json")).sort()) {
  const data = JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as { runs: Run[] };

  for (const scenario of ["answer", "tool", "chain"]) {
    const bad = data.runs.filter((r) => r.scenario === scenario && !r.pass);
    const first = bad[0];

    if (!first) {
      continue;
    }

    console.log(`\n## ${name} ${scenario}: ${bad.length} failing`);

    for (const step of first.steps) {
      console.log(`- ${step.label} ${step.pass ? "ok" : "FAIL"} ${step.note}`);
      console.log(`  in: ${step.requestSummary}`);
      console.log(`  raw: ${JSON.stringify(step.raw).slice(0, 220)}`);
    }
  }
}
