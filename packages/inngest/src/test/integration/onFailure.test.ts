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

test("skip schema validation", async () => {
  // Runtime schema on the main function's `triggers` does not apply to the
  // `onFailure` handler.

  const state = createState({
    counters: [] as number[],
    onFailureReached: false,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    {
      id: "fn",
      onFailure: () => {
        state.onFailureReached = true;
      },
      retries: 0,
      triggers: eventType(eventName, { schema: z.object({ msg: z.string() }) }),
    },
    ({ runId }) => {
      state.runId = runId;
      throw new Error("test");
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ data: { msg: "hi" }, name: eventName });
  await state.waitForRunFailed();
  await waitFor(() => {
    expect(state.onFailureReached).toBe(true);
  });
});
