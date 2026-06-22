import {
  createState,
  createTestApp,
  getRunMetadata,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createScorer } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("scorer targets the attached experiment", async () => {
  const parentState = createState({});
  const client = new Inngest({ id: randomSuffix(testFileName), isDev: true });
  const eventName = randomSuffix("evt");

  const scorer = createScorer(client, { id: "s" }, async () => ({
    name: "rizz",
    value: 100,
  }));
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: { event: eventName } },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer("s", {
        function: scorer,
        data: {},
        experiment: { experimentName: "exp", variant: "control" },
      });
    },
  );
  await createTestApp({ client, functions: [fn, scorer], serve: createServer });
  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();

  const meta = await getRunMetadata(await parentState.waitForRunId());
  expect(meta).toEqual(
    expect.arrayContaining([
      {
        kind: "inngest.experiment",
        scope: "run",
        updatedAt: expect.any(String),
        values: { experiment_name: "exp", variant: "control" },
      },
      {
        kind: "inngest.score.rizz",
        scope: "run",
        updatedAt: expect.any(String),
        values: { value: 100 },
      },
    ]),
  );
});

test("success", async () => {
  const parentState = createState({});
  const scorerState = createState({
    event: null as unknown as { data: { message: string } },
    parents: null as unknown as { fnSlug: string; runId: string }[],
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fooScorer = createScorer(
    client,
    { id: "foo", schema: z.object({ message: z.string() }) },
    async ({ event, parents, runId }) => {
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<{ message: string }>();
      expectTypeOf(parents).toEqualTypeOf<
        [{ fnSlug: string; runId: string }]
      >();
      scorerState.event = event;
      scorerState.parents = parents;
      scorerState.runId = runId;
      return {
        name: "verbosity",
        value: event.data.message.split(" ").length,
      };
    },
  );
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      await step.run("a", async () => {
        defer("foo", {
          data: { message: "hello world" },
          function: fooScorer,
        });
      });
    },
  );
  await createTestApp({
    client,
    functions: [fn, fooScorer],
    serve: createServer,
  });

  // Trigger and wait for completion
  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await scorerState.waitForRunComplete();

  // Scorer got the correct data
  expect(scorerState.event.data).toEqual({ message: "hello world" });
  expect(scorerState.parents).toEqual([
    {
      fnSlug: `${client.id}-fn`,
      runId: parentState.runId,
    },
  ]);

  // Scorer updated the parent run's metadata
  const metadata = await getRunMetadata(await parentState.waitForRunId());
  expect(metadata).toEqual(
    expect.arrayContaining([
      {
        kind: "inngest.score.verbosity",
        scope: "run",
        updatedAt: expect.any(String),
        values: { value: 2 },
      },
    ]),
  );
});
