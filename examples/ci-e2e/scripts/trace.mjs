/**
 * Print a run's trace from a Dev Server's `/v0/gql`, and a summary of the facts
 * the suite asserts on: JOB groups, spans per name, invokes, warnings, origin.
 *
 *   node scripts/trace.mjs <port> <runId> [--tree]
 *
 * Start a Dev Server on an old run with `npx inngest-ci open <runId>`.
 */
const [port, runId, flag] = process.argv.slice(2);

const fields =
  "name stepType groupKind origin status startedAt endedAt stepOp metadata{kind scope values}";

let nested = "";
for (let i = 0; i < 9; i++) {
  nested = `childrenSpans{${fields} ${nested}}`;
}

const query = `query{runTrace(runID:"${runId}"){${fields} ${nested}}}`;

const response = await fetch(`http://127.0.0.1:${port}/v0/gql`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query }),
});

const body = await response.json();

if (body.errors) {
  console.log(JSON.stringify(body.errors).slice(0, 600));
  process.exit(1);
}

const seconds = (span) => {
  if (!span.startedAt || !span.endedAt) {
    return "";
  }

  return `${((Date.parse(span.endedAt) - Date.parse(span.startedAt)) / 1000).toFixed(1)}s`;
};

const counts = new Map();
const warnings = new Set();
const groups = [];
const stepOps = new Map();
let spans = 0;
let withOrigin = 0;
const nesting = [];
const kinds = new Map();

const walk = (span, depth, path) => {
  spans++;
  counts.set(span.name, (counts.get(span.name) ?? 0) + 1);

  if (span.origin) {
    withOrigin++;
  }

  if (span.groupKind) {
    groups.push(`${span.groupKind}:${span.name}`);
  }

  if (span.stepOp) {
    stepOps.set(span.stepOp, (stepOps.get(span.stepOp) ?? 0) + 1);
  }

  for (const meta of span.metadata ?? []) {
    if (meta.kind.includes("warning")) {
      warnings.add(`${span.name}: ${JSON.stringify(meta.values)}`);
    }

    if (JSON.stringify(meta).includes("NESTING_STEPS")) {
      nesting.push(`${path}/${span.name} (${meta.kind})`);
    }

    kinds.set(meta.kind, (kinds.get(meta.kind) ?? 0) + 1);
  }

  if (flag === "--tree") {
    console.log(
      `${"  ".repeat(depth)}${span.name} [${span.status}] ${seconds(span)}${span.groupKind ? ` group=${span.groupKind}` : ""}${span.origin ? ` origin=${span.origin}` : ""}${span.stepOp ? ` op=${span.stepOp}` : ""}`,
    );
  }

  for (const child of span.childrenSpans ?? []) {
    walk(child, depth + 1, `${path}/${span.name}`);
  }
};

const root = body.data.runTrace;

walk(root, 0, "");

console.log(`root: ${root.name} [${root.status}] ${seconds(root)}`);
console.log(`spans: ${spans}, with origin: ${withOrigin}`);
console.log(`groups: ${groups.join(", ") || "-"}`);
console.log(
  `metadata kinds: ${[...kinds].map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`,
);
console.log(`stepOps: ${[...stepOps].map(([k, v]) => `${k}=${v}`).join(" ")}`);

const dupes = [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
console.log(`names seen more than once: ${dupes.join("; ") || "-"}`);

for (const warning of warnings) {
  console.log(`warning: ${warning.slice(0, 400)}`);
}

if (nesting.length) {
  console.log(`NESTING metadata at: ${nesting.join(", ")}`);
}
