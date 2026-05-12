import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createScorer } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("success", async () => {
  const parentState = createState({});
  const deferState = createState({
    event: null as unknown as {
      data: {
        input: { message: string };
        parent: { fnSlug: string; runId: string };
      };
    },
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createScorer(
    client,
    { id: "foo", schema: z.object({ message: z.string() }) },
    async ({ event, runId }) => {
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<{
        input: { message: string };
        parent: { fnSlug: string; runId: string };
      }>();
      deferState.event = event;
      deferState.runId = runId;
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
        defer("foo", { function: foo, data: { message: "hi" } });
      });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();
  expect(deferState.event.data).toEqual({
    input: { message: "hi" },
    parent: { fnSlug: `${client.id}-fn`, runId: parentState.runId },
  });
});
