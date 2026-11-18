import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod/v3";
import { createClient } from "../../test/helpers.ts";
import { StepMode } from "../../types.ts";
import type { ExecutionResults } from "../execution/InngestExecution.ts";
import { eventType } from "./triggers.ts";

// End-to-end checks that `eventType()` schemas are enforced at runtime, both
// when sending events and when running a function.

const userCreated = eventType("app/user.created", {
  schema: z.object({ email: z.string() }),
});

const createSendClient = () => {
  const fetch = vi.fn(async (_url: string, opts: { body: string }) => {
    const ids = (JSON.parse(opts.body) as unknown[]).map(() => "test-id");
    return new Response(JSON.stringify({ status: 200, ids }));
  });

  const inngest = createClient({
    id: "test",
    isDev: true,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });

  return { inngest, fetch };
};

describe("send", () => {
  test("rejects an invalid created event without sending it", async () => {
    const { inngest, fetch } = createSendClient();

    await expect(
      // @ts-expect-error - invalid data on purpose
      inngest.send(userCreated.create({ email: 123 })),
    ).rejects.toThrowError("email");

    expect(fetch).not.toHaveBeenCalled();
  });

  test("sends a valid created event", async () => {
    const { inngest, fetch } = createSendClient();

    await expect(
      inngest.send(userCreated.create({ email: "user@example.com" })),
    ).resolves.toMatchObject({ ids: ["test-id"] });

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("function run", () => {
  const run = async (data: unknown) => {
    const handler = vi.fn(() => "done");
    const client = createClient({ id: "test" });
    const fn = client.createFunction(
      { id: "welcome-user", triggers: [userCreated] },
      handler,
    );

    const event = { name: userCreated.name, data };
    const execution = fn["createExecution"]({
      partialOptions: {
        client,
        data: fromPartial({ event, events: [event] }),
        runId: "test-run-id",
        stepState: {},
        stepCompletionOrder: [],
        reqArgs: [],
        headers: {},
        stepMode: StepMode.Async,
      },
    });

    return { result: await execution.start(), handler };
  };

  test("fails without retries when the event doesn't match the schema", async () => {
    const { result, handler } = await run({ email: 123 });

    expect(handler).not.toHaveBeenCalled();
    expect(result.type).toBe("function-rejected");
    expect((result as ExecutionResults["function-rejected"]).retriable).toBe(
      false,
    );
  });

  test("runs the handler when the event matches the schema", async () => {
    const { result, handler } = await run({ email: "user@example.com" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("function-resolved");
  });
});
