import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test, vi } from "vitest";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("checkpoint timeouts from a custom fetch are handled, not surfaced as errors", async () => {
  const state = createState({ enterCount: 0, aCount: 0, bCount: 0 });
  const internalLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  let checkpointTimeouts = 0;
  const timeoutCheckpointsFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (!new URL(url).pathname.startsWith("/v1/checkpoint")) {
      return fetch(input, init);
    }

    await fetch(input, init);
    checkpointTimeouts++;
    throw new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
  };

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    fetch: timeoutCheckpointsFetch,
    internalLogger,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
      checkpointing: true,
    },
    async ({ runId, step }) => {
      state.runId = runId;
      state.enterCount++;
      await step.run("a", async () => {
        state.aCount++;
        return "a";
      });
      await step.run("b", async () => {
        state.bCount++;
        return "b";
      });
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  expect(checkpointTimeouts).toBeGreaterThanOrEqual(2);

  expect(result).toBe("done");
  expect(state.aCount).toBe(1);
  expect(state.bCount).toBe(1);

  expect(internalLogger.error).not.toHaveBeenCalled();
});
