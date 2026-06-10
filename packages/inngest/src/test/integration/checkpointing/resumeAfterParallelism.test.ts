import {
  createState,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../../index.ts";
import { createRecordedTestApp } from "./recordingProxy.ts";

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

/**
 * Two sequential steps, a `Promise.all` of two parallel steps, then three
 * more sequential steps, with all executor↔SDK traffic recorded.
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

  const { requests } = await createRecordedTestApp({
    client,
    functions: [fn],
  });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  return { counts: state.counts, requests, result };
}

/**
 * The run completes, and after the parallel steps drain the executor returns
 * the run to checkpointing instead of forcing a StepPlanned→StepRun round
 * trip for every remaining step.
 */
function assertResumesCheckpointing(
  scenario: Awaited<ReturnType<typeof runScenario>>,
): void {
  const { counts, requests, result } = scenario;

  expect(result).toBe("done");
  for (const name of stepNames) {
    expect(counts[name], `step ${name} should run exactly once`).toBe(1);
  }

  // POSTs are run traffic; the registration PUT is not.
  const posts = requests.filter((r) => r.method === "POST");
  expect(posts.length).toBeGreaterThan(0);

  const first = posts[0];
  expect(first?.requestReqVersion).toBe("-1");
  expect(first?.responseReqVersion).toBe("2");

  // Checkpointing resumed: no StepPlanned discovery for the trailing
  // sequential steps.
  const trailingPlanned = posts.flatMap((r) =>
    r.responseOps.filter(
      (op) =>
        op.op === "StepPlanned" &&
        (op.displayName ?? op.name ?? "").startsWith("after-"),
    ),
  );
  expect(trailingPlanned).toHaveLength(0);

  // The request that completed the run was no longer forcing step planning.
  const finalPost = posts.find((r) =>
    r.responseOps.some((op) => op.op === "RunComplete"),
  );
  expect(finalPost?.disableImmediateExecution).toBe(false);
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
