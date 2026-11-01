/**
 * @module
 * Runs the tour's three scenarios against one local model, N times each, and
 * prints and saves everything it sees. Throwaway prototype.
 *
 *   pnpm tour:model-proto -- --model qwen3-1.7b --runs 10
 *   options: --scenarios answer,tool,chain  --threads 4  --no-cache  --tag x
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { resolveModelFile } from "node-llama-cpp";

import { cacheDir, candidates } from "./models.ts";
import { localModel } from "./local-model.ts";
import { type Run, scenarios } from "./scenarios.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    runs: { type: "string", default: "10" },
    scenarios: { type: "string", default: "answer,tool,chain" },
    threads: { type: "string" },
    "no-cache": { type: "boolean", default: false },
    tag: { type: "string", default: "" },
  },
  allowPositionals: true,
});
const candidate = candidates.find((c) => {
  return c.name === values.model;
});

if (!candidate) {
  throw new Error(
    `--model one of: ${candidates.map((c) => c.name).join(", ")}`,
  );
}

const availableMb = (): number => {
  const line = readFileSync("/proc/meminfo", "utf8").match(
    /MemAvailable:\s+(\d+)/,
  );

  return line ? Number(line[1]) / 1024 : Number.POSITIVE_INFINITY;
};

if (availableMb() < 4096) {
  throw new Error(`only ${Math.round(availableMb())} MB available, stopping`);
}

mkdirSync(cacheDir, { recursive: true });

const downloadStarted = performance.now();
const file = await resolveModelFile(candidate.uri, {
  directory: cacheDir,
  cli: true,
});
const downloadMs = performance.now() - downloadStarted;
const sizeBytes = statSync(file).size;
let peakRss = 0;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);
const local = await localModel(file, {
  cache: !values["no-cache"],
  threads: values.threads ? Number(values.threads) : undefined,
});

console.log(
  `\n${candidate.name}: ${(sizeBytes / 1e9).toFixed(2)} GB, loaded in ${Math.round(local.loadMs)} ms (download step ${Math.round(downloadMs)} ms)`,
);

const harness = {
  model: local.model,
  stats: () => {
    return local.last();
  },
};
const runs: Array<Run & { load: number }> = [];
const wanted = (values.scenarios ?? "").split(",") as Array<
  keyof typeof scenarios
>;
const count = Number(values.runs);

for (const name of wanted) {
  for (let index = 1; index <= count; index += 1) {
    if (availableMb() < 4096) {
      throw new Error("available memory under 4 GB, stopping");
    }

    const load = loadavg()[0] ?? 0;
    const run = { ...(await scenarios[name](harness)), load };

    runs.push(run);
    console.log(
      `\n[${name} ${index}/${count}] ${run.pass ? "PASS" : "FAIL"} reached ${run.reached}/${run.of} in ${Math.round(run.ms)} ms`,
    );

    for (const step of run.steps) {
      console.log(
        `  ${step.pass ? "ok  " : "FAIL"} ${step.label} (${Math.round(step.ms)} ms, ttft ${Math.round(step.firstTokenMs)}, ${step.outputTokens} tok) ${step.note}`,
      );
      console.log(`       in : ${step.requestSummary}`);
      console.log(`       raw: ${JSON.stringify(step.raw).slice(0, 300)}`);
    }
  }
}

clearInterval(sampler);
peakRss = Math.max(peakRss, process.memoryUsage().rss);

const result = {
  model: candidate.name,
  uri: candidate.uri,
  file,
  sizeBytes,
  loadMs: local.loadMs,
  peakRssBytes: peakRss,
  cache: !values["no-cache"],
  threads: values.threads ? Number(values.threads) : cpus().length,
  machine: {
    cpu: cpus()[0]?.model,
    logicalCores: cpus().length,
    totalMemGb: Math.round(totalmem() / 2 ** 30),
    loadavgAtEnd: loadavg(),
  },
  runs,
};
const out = `${import.meta.dirname}/results/${candidate.name}${values.tag ? `-${values.tag}` : ""}.json`;

mkdirSync(`${import.meta.dirname}/results`, { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`\nsaved ${out}; peak RSS ${(peakRss / 1e9).toFixed(2)} GB`);

await local.dispose();
process.exit(0);
