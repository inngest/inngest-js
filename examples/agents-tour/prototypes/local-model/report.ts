/**
 * @module
 * Summarizes the saved results into the markdown table. Throwaway prototype.
 *
 *   node prototypes/local-model/report.ts
 */
import { readdirSync, readFileSync } from "node:fs";

import type { Run } from "./scenarios.ts";

const dir = `${import.meta.dirname}/results`;
const pct = (sorted: number[], p: number): number => {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

console.log(
  "| result | scenario | pass | reached (steps) | median s | p90 s | ttft ms | tok/s |",
);
console.log("|---|---|---|---|---|---|---|---|");

for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const data = JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as {
    runs: Run[];
  };

  for (const scenario of ["answer", "tool", "chain"]) {
    const runs = data.runs.filter((run) => {
      return run.scenario === scenario;
    });

    if (runs.length === 0) {
      continue;
    }

    const times = runs
      .map((run) => {
        return run.ms;
      })
      .sort((a, b) => {
        return a - b;
      });
    const steps = runs.flatMap((run) => {
      return run.steps;
    });
    const ttft =
      steps.reduce((sum, s) => {
        return sum + s.firstTokenMs;
      }, 0) / steps.length;
    const gen = steps.filter((s) => {
      return s.outputTokens > 1 && s.ms > s.firstTokenMs;
    });
    const tps =
      gen.reduce((sum, s) => {
        return sum + (s.outputTokens - 1) / ((s.ms - s.firstTokenMs) / 1000);
      }, 0) / Math.max(1, gen.length);
    const reached = [0, 1, 2, 3, 4]
      .slice(1, runs[0]?.of + 1)
      .map((k) => {
        return runs.filter((run) => {
          return run.reached >= k;
        }).length;
      })
      .join("/");

    console.log(
      `| ${name.replace(".json", "")} | ${scenario} | ${runs.filter((r) => r.pass).length}/${runs.length} | ${reached} | ${(pct(times, 0.5) / 1000).toFixed(1)} | ${(pct(times, 0.9) / 1000).toFixed(1)} | ${Math.round(ttft)} | ${tps.toFixed(1)} |`,
    );
  }
}
