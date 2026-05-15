import type { RunMetadata, TraceMetadataNode } from "@inngest/test-harness";
import {
  createState,
  createTestApp,
  getRunMetadata,
  getRunTraceMetadata,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { scoreMiddleware } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

function scoreEntries(metadata: RunMetadata[]) {
  return metadata.filter((md) => md.kind === "inngest.score");
}

function scoreValues(metadata: RunMetadata[]) {
  return Object.assign({}, ...scoreEntries(metadata).map((md) => md.values));
}

function expectScoreValue(
  metadata: RunMetadata[],
  name: string,
  value: number,
) {
  expect(scoreValues(metadata)).toEqual(
    expect.objectContaining({ [name]: value }),
  );
}

function expectNoScoreValue(metadata: RunMetadata[], name: string) {
  expect(scoreValues(metadata)).not.toHaveProperty(name);
}

function flattenTrace(node: TraceMetadataNode): TraceMetadataNode[] {
  return [node, ...node.childrenSpans.flatMap(flattenTrace)];
}

function findSpanByName(trace: TraceMetadataNode, name: string) {
  const spans = flattenTrace(trace);
  const span = spans.find((node) => node.name === name);
  if (!span) {
    throw new Error(
      `Unable to find span "${name}". Found spans: ${spans
        .map((node) => node.name)
        .join(", ")}`,
    );
  }
  return span;
}

test("client.score outside a function writes run-scoped metadata", async () => {
  const state = createState({});

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ runId }) => {
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  const runId = await state.waitForRunId();
  await client.score({ runId, name: "external_score", value: 3 });

  const metadata = await getRunMetadata(runId);
  expectScoreValue(metadata, "external_score", 3);
  expect(scoreEntries(metadata)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "inngest.score",
        scope: "run",
        values: expect.objectContaining({ external_score: 3 }),
      }),
    ]),
  );
});

test("client.score inside step.run routes run and step metadata by scope", async () => {
  const state = createState({});

  const client = new Inngest({
    checkpointing: true,
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ runId, step }) => {
      state.runId = runId;
      await step.run("writer-step", async () => {
        await client.score({
          runId,
          stepId: "writer-step",
          name: "step_quality",
          value: 1,
        });
        await client.score({
          runId,
          name: "run_quality",
          value: 2,
        });
      });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  const runId = await state.waitForRunId();
  const runMetadata = await getRunMetadata(runId);
  expectScoreValue(runMetadata, "run_quality", 2);
  expectNoScoreValue(runMetadata, "step_quality");

  const trace = await getRunTraceMetadata(runId);
  const writerStep = findSpanByName(trace, "writer-step");
  expectScoreValue(writerStep.metadata, "step_quality", 1);
  expectNoScoreValue(writerStep.metadata, "run_quality");
});

test("step.score writes run-scoped metadata by default", async () => {
  const state = createState({});

  const client = new Inngest({
    checkpointing: true,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [scoreMiddleware()],
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ runId, step }) => {
      state.runId = runId;
      await step.score("run-quality", { name: "run_quality", value: true });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  const runId = await state.waitForRunId();
  const metadata = await getRunMetadata(runId);
  expectScoreValue(metadata, "run_quality", 1);

  const trace = await getRunTraceMetadata(runId);
  findSpanByName(trace, "score:run-quality");
});
