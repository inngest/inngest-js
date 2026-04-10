import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("onDefer handler is triggered by defer()", async () => {
  const state = createState({
    deferredData: null as Record<string, unknown> | null,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: async ({ event, step }) => {
        await step.run("capture-data", () => {
          state.deferredData = event.data.data as Record<string, unknown>;
        });
      },
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ defer, runId, step }: Record<string, any>) => {
      state.runId = runId;

      const msg = await step.run("create-msg", () => {
        return "hello";
      });

      await step.run("defer-1", async () => {
        await defer({ data: { msg } });
      });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.deferredData).toEqual({ msg: "hello" });
  });
});
