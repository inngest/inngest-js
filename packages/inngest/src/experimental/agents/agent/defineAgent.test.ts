/**
 * @module
 * Tests for defining an agent: the optional handler, `idle`, the value or
 * function fields and the run's end.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createKv, memoryKvAdapter } from "../kv/kv.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { run } from "./test-helpers.ts";

const makeClient = () => {
  return new Inngest({ id: testClientId });
};

describe("an agent with no handler", () => {
  test("runs, posts nothing and ends with output undefined", async () => {
    const agents = createAgents(makeClient(), { store: memoryKvAdapter() });
    const defined = agents.agent({
      id: "plain",
      triggers: [{ event: "shop/order", thread: "event.data.id" }],
    });

    const { output, error, waiting } = await run(defined.fn, {
      event: { name: "shop/order", data: { id: "o1" } },
    });

    expect(error).toBeUndefined();
    expect(waiting).toBe(false);
    // The executor stores a missing output as null.
    expect(output ?? undefined).toBeUndefined();
  });

  test("createAgentFunction takes no body", async () => {
    const { fn } = createAgentFunction(makeClient(), {
      id: "plain",
      kv: createKv({ adapter: memoryKvAdapter() }),
      triggers: { event: "shop/order", thread: "event.data.id" },
    });

    const { output, error, waiting } = await run(fn, {
      event: { name: "shop/order", data: { id: "o1" } },
    });

    expect(error).toBeUndefined();
    expect(waiting).toBe(false);
    // The executor stores a missing output as null.
    expect(output ?? undefined).toBeUndefined();
  });
});

describe("idle", () => {
  const order = { name: "shop/order", data: { id: "o1" } };

  const waitTimeouts = (ops: { op: string; opts: unknown }[]) => {
    return ops
      .filter((op) => {
        return op.op === "wait";
      })
      .map((op) => {
        return (op.opts as { timeout?: string }).timeout;
      })
      .filter((timeout) => {
        return timeout !== undefined;
      });
  };

  const defineLoop = (
    form: "batches" | "messages",
    idle?: number | string | ((context: { thread: { key: string } }) => string),
  ) => {
    return createAgentFunction(
      makeClient(),
      {
        id: "waiter",
        kv: createKv({ adapter: memoryKvAdapter() }),
        triggers: { event: "shop/order", thread: "event.data.id" },
        ...(idle !== undefined && { idle }),
      } as never,
      async ({ inbox }) => {
        let seen = 0;

        if (form === "batches") {
          for await (const batch of inbox.batches()) {
            seen += batch.length;
          }
        } else {
          for await (const _message of inbox) {
            seen += 1;
          }
        }

        return seen;
      },
    );
  };

  test.each([["batches" as const], ["messages" as const]])(
    "with a short idle, for await over %s ends after that much quiet",
    async (form) => {
      const { fn } = defineLoop(form, "5m");

      const { output, ops, waiting } = await run(fn, {
        event: order,
        timeouts: 1,
      });

      expect(waiting).toBe(false);
      expect(output).toBe(1);
      expect(waitTimeouts(ops)).toEqual(["5m"]);
    },
  );

  test("without idle the default is 10 minutes", async () => {
    const { fn } = defineLoop("batches");

    const { ops } = await run(fn, { event: order, timeouts: 1 });

    expect(waitTimeouts(ops)).toEqual(["10m"]);
  });

  test("a function of the thread is read once and gives the idle", async () => {
    let calls = 0;
    const { fn } = defineLoop("messages", ({ thread }) => {
      calls += 1;

      return thread.key === "o1" ? "2m" : "1h";
    });

    const { ops } = await run(fn, { event: order, timeouts: 1 });

    expect(waitTimeouts(ops)).toEqual(["2m"]);
    // Once per request of the run, not once per read.
    expect(calls).toBeGreaterThan(0);
  });
});
