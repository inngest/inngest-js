import {
  createState,
  createTestApp,
  getRunTraceMetadata,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { describe, expect, test } from "vitest";
import { clientProcessorMap } from "../../../components/execution/otel/access.ts";
import { aiMiddleware } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import {
  expectNoSpanByName,
  expectScoreValue,
  findSpanByName,
} from "../scoring/utils.ts";

// The bundle's default traces behaviour is "extendProvider", which only works
// if a global OTel provider exists before the middleware factory runs.
trace.setGlobalTracerProvider(new BasicTracerProvider());
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const testFileName = testNameFromFileUrl(import.meta.url);

describe("aiMiddleware", () => {
  test("score, metadata, and tracer all work through one run", async () => {
    const state = createState({});

    const client = new Inngest({
      checkpointing: true,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: aiMiddleware(),
    });
    expect(clientProcessorMap.get(client)).toBeDefined();

    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ runId, step, tracer }) => {
        state.runId = runId;

        await step.run("traced-step", () => {
          tracer.startActiveSpan("bundle-span", (span) => {
            span.end();
          });
        });

        await step.metadata("set-status").run().update({ status: "done" });
        await step.score("run-score", { name: "bundle_score", value: true });
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName, data: {} });
    await state.waitForRunComplete();
    const runTrace = await getRunTraceMetadata(await state.waitForRunId());

    expectScoreValue(runTrace.metadata, "bundle_score", true);

    findSpanByName(runTrace, "bundle-span");
    findSpanByName(runTrace, "set-status");
    expect(
      runTrace.metadata.find((md) => md.kind === "userland.default")?.values,
    ).toEqual(expect.objectContaining({ status: "done" }));
  });

  test('traces "off" sends no spans, but metadata and score still work', async () => {
    const state = createState({});

    const client = new Inngest({
      checkpointing: true,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: aiMiddleware({ traces: { behaviour: "off" } }),
    });
    expect(clientProcessorMap.get(client)).toBeUndefined();

    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ runId, step, tracer }) => {
        state.runId = runId;

        await step.run("traced-step", () => {
          tracer.startActiveSpan("bundle-span", (span) => {
            span.end();
          });
        });

        await step.metadata("set-status").run().update({ status: "done" });
        await step.score("run-score", { name: "bundle_score", value: false });
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName, data: {} });
    await state.waitForRunComplete();
    const runTrace = await getRunTraceMetadata(await state.waitForRunId());

    expectScoreValue(runTrace.metadata, "bundle_score", false);
    expect(
      runTrace.metadata.find((md) => md.kind === "userland.default")?.values,
    ).toEqual(expect.objectContaining({ status: "done" }));
    expectNoSpanByName(runTrace, "bundle-span");
  });
});
