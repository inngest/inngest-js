import type { Server } from "node:http";
import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

const stepNames = [
  "seq-1",
  "seq-2",
  "par-1",
  "par-2",
  "after-1",
  "after-2",
  "after-3",
] as const;

interface RecordedOp {
  op: string;
  name?: string;
  displayName?: string;
}

function isOpLike(value: unknown): value is RecordedOp {
  return (
    typeof value === "object" &&
    value !== null &&
    "op" in value &&
    typeof value.op === "string"
  );
}

/**
 * Capture every op the app returns to the executor so tests can assert on
 * the executor↔SDK protocol. Only responses are tapped; request bodies are
 * left untouched because the comm handler reads them lazily.
 */
function recordResponseOps(server: Server): RecordedOp[] {
  const ops: RecordedOp[] = [];

  server.prependListener("request", (_req, res) => {
    const chunks: Buffer[] = [];
    const write = res.write.bind(res);
    const end = res.end.bind(res);

    res.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      chunks.push(Buffer.from(chunk));
      return write(chunk, ...rest);
    }) as typeof res.write;

    res.end = ((chunk?: unknown, ...rest: never[]) => {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
      return end(chunk as never, ...rest);
    }) as typeof res.end;

    res.on("finish", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return;
      }
      for (const item of Array.isArray(body) ? body : [body]) {
        if (isOpLike(item)) {
          ops.push(item);
        }
      }
    });
  });

  return ops;
}

/**
 * Two sequential steps, a `Promise.all` of two parallel steps, then three
 * more sequential steps, with every op the SDK returns to the executor
 * recorded.
 */
async function runScenario(opts: { optimizeParallelism?: boolean }) {
  const state = createState({
    counts: {} as Record<string, number>,
  });

  const track = (name: string): string => {
    state.counts[name] = (state.counts[name] ?? 0) + 1;
    return name;
  };

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    checkpointing: true,
    optimizeParallelism: opts.optimizeParallelism,
  });

  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: { event: eventName } },
    async ({ runId, step }) => {
      state.runId = runId;
      await step.run("seq-1", () => track("seq-1"));
      await step.run("seq-2", () => track("seq-2"));
      await Promise.all([
        step.run("par-1", () => track("par-1")),
        step.run("par-2", () => track("par-2")),
      ]);
      await step.run("after-1", () => track("after-1"));
      await step.run("after-2", () => track("after-2"));
      await step.run("after-3", () => track("after-3"));
      return "done";
    },
  );

  const { server } = await createTestApp({
    client,
    functions: [fn],
    serve: createServer,
  });
  const responseOps = recordResponseOps(server);

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  return { counts: state.counts, responseOps, result };
}

/**
 * The run completes, and after the parallel steps drain the executor returns
 * the run to checkpointing instead of forcing a StepPlanned→StepRun round
 * trip for every remaining step.
 */
function assertResumesCheckpointing(
  scenario: Awaited<ReturnType<typeof runScenario>>,
): void {
  const { counts, responseOps, result } = scenario;

  expect(result).toBe("done");
  for (const name of stepNames) {
    expect(counts[name], `step ${name} should run exactly once`).toBe(1);
  }

  // Guards against the StepPlanned assertion below passing vacuously if
  // response recording breaks.
  expect(responseOps.map((op) => op.op)).toContain("RunComplete");

  // Checkpointing resumed: no StepPlanned discovery for the trailing
  // sequential steps.
  const trailingPlanned = responseOps.filter(
    (op) =>
      op.op === "StepPlanned" &&
      (op.displayName ?? op.name ?? "").startsWith("after-"),
  );
  expect(trailingPlanned).toHaveLength(0);
}

test("resumes checkpointing after parallelism (default config)", async () => {
  const scenario = await runScenario({});
  assertResumesCheckpointing(scenario);
});

// Pins the fix for inngest/inngest#3717: the executor stamps the reported
// version into run metadata on the first request, and its ForceStepPlan
// reset only applies to stamped versions >= 2. Reporting 1 for an opted-out
// run would permanently disable checkpointing after a `Promise.all`.
test("resumes checkpointing after parallelism (optimizeParallelism: false)", async () => {
  const scenario = await runScenario({ optimizeParallelism: false });
  assertResumesCheckpointing(scenario);
});
