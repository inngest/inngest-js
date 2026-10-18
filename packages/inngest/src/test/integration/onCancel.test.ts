import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import z from "zod";
import { eventType } from "../../components/triggers/triggers.ts";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("runs onCancel with the cancelled run's details", async () => {
  const state = createState({
    mainCalls: 0,
    cancelled: null as null | {
      name: string;
      functionId: string;
      runId: string;
      originalEventName: string;
      originalEventData: unknown;
    },
  });

  const triggerName = randomSuffix("evt");
  const cancelName = randomSuffix("cancel");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      // Runtime schema on the main function's `triggers` must not apply to
      // the `onCancel` handler, which receives an internal event.
      triggers: eventType(triggerName, {
        schema: z.object({ id: z.string() }),
      }),
      cancelOn: [{ event: cancelName, match: "data.id" }],
      onCancel: ({ event }) => {
        state.cancelled = {
          name: event.name,
          functionId: event.data.function_id,
          runId: event.data.run_id,
          originalEventName: event.data.event.name,
          originalEventData: event.data.event.data,
        };
      },
    },
    async ({ runId, step }) => {
      state.mainCalls++;
      state.runId = runId;
      await step.sleep("wait", "5m");
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: triggerName, data: { id: "abc" } });
  const runId = await state.waitForRunId();

  await client.send({ name: cancelName, data: { id: "abc" } });

  await waitFor(() => {
    expect(state.cancelled).not.toBeNull();
  });

  expect(state.cancelled).toEqual({
    name: "inngest/function.cancelled",
    functionId: `${client.id}-fn`,
    runId,
    originalEventName: triggerName,
    originalEventData: { id: "abc" },
  });
  expect(state.mainCalls).toBe(1);
});
