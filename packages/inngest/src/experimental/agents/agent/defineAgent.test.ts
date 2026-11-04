/**
 * @module
 * Tests for defining an agent: the optional handler, `idle`, the value or
 * function fields and the run's end.
 */

import { z } from "zod";
import { Inngest } from "../../../components/Inngest.ts";
import { eventType } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { freshKv, run } from "./test-helpers.ts";

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

  test.each([["batches" as const], ["messages" as const]])(
    "an idle of 0 ends the %s loop the moment it would wait, as a run opened through a handle does",
    async (form) => {
      const { fn } = defineLoop(form, 0);

      const { output, waiting, ops } = await run(fn, { event: order });

      expect(waiting).toBe(false);
      expect(output).toBe(1);
      expect(waitTimeouts(ops)).toEqual([]);
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

describe("optimizeParallelism", () => {
  const warned = () => {
    const warn = vi.fn();
    const client = new Inngest({
      id: testClientId,
      isDev: true,
      internalLogger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    return { client, warn };
  };

  const deprecations = (warn: ReturnType<typeof vi.fn>) => {
    return warn.mock.calls.filter(([message]) => {
      return String(message).includes("optimizeParallelism");
    });
  };

  test("an agent function runs with it off and the SDK does not warn about it", () => {
    const { client, warn } = warned();
    const { fn } = createAgentFunction(client, {
      id: "quiet-agent",
    });

    expect(fn["opts"].optimizeParallelism).toBe(false);
    expect(deprecations(warn)).toHaveLength(0);
  });

  test("a plain function that sets the option still gets the warning", () => {
    const { client, warn } = warned();

    client.createFunction(
      {
        id: "loud-plain",
        optimizeParallelism: false,
        triggers: [{ event: "foo" }],
      },
      vi.fn(),
    );

    expect(deprecations(warn)).toHaveLength(1);
  });
});

describe("the handler's event, me and inbox", () => {
  const order = eventType("shop/order", {
    schema: z.object({ id: z.string(), total: z.number() }),
  });
  const refund = eventType("shop/refund", {
    schema: z.object({ id: z.string() }),
  });
  const agents = createAgents(makeClient(), { store: memoryKvAdapter() });
  const config = {
    id: "shop",
    triggers: [order, refund],
    thread: "event.data.id",
  } as const;

  test("event is exactly the event sent, is() narrows it, the inbox opens with it and me.key is the thread key", async () => {
    let seen: Record<string, unknown> = {};
    const { fn } = agents.agent(config, async ({ event, inbox, me }) => {
      const first = await inbox.next();

      seen = {
        event: { name: event.name, data: event.data },
        isOrder: event.is(order),
        isRefund: event.is(refund),
        first: { name: first?.name, data: first?.data },
        key: me.key,
      };
    });

    await run(fn, {
      event: { name: "shop/order", data: { id: "o1", total: 5 } },
    });

    expect(seen).toEqual({
      event: { name: "shop/order", data: { id: "o1", total: 5 } },
      isOrder: true,
      isRefund: false,
      first: { name: "shop/order", data: { id: "o1", total: 5 } },
      key: "o1",
    });
  });

  test("the handler gets no trigger, no thread handle and no wrapper around the event", async () => {
    let seen: Record<string, unknown> = {};
    const { fn } = agents.agent(
      { ...config, id: "shop-plain" },
      async (context) => {
        seen = context as unknown as Record<string, unknown>;
      },
    );

    await run(fn, {
      event: { name: "shop/order", data: { id: "o1", total: 5 } },
    });

    expect(seen).not.toHaveProperty("trigger");
    expect(seen).not.toHaveProperty("thread");
    expect(
      (seen.event as { data: Record<string, unknown> }).data,
    ).not.toHaveProperty("agent");
    expect(Object.keys(seen.me as object)).toEqual([
      "key",
      "report",
      "message",
    ]);
  });
});

describe("a trigger with nothing at its thread path", () => {
  test("starts a thread of its own and the trace warns on the step that started the run", async () => {
    const warn = vi.fn();
    const client = new Inngest({
      id: testClientId,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    const agents = createAgents(client, { store: memoryKvAdapter() });
    let key = "";
    const { fn } = agents.agent(
      {
        id: "fresh",
        triggers: [{ event: "shop/order", thread: "event.data.pr" }],
      },
      async ({ me }) => {
        key = me.key;
      },
    );
    const steps: { name?: string; metadata?: unknown }[] = [];

    await run(fn, {
      event: { name: "shop/order", data: { id: "e1" } },
      onStep: (op) => {
        steps.push({ name: op.name, metadata: op.metadata });
      },
    });

    expect(key).toMatch(/^fresh:/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("event.data.pr"));
    expect(
      steps.find((step) => step.name === "thread:start")?.metadata,
    ).toEqual([
      expect.objectContaining({
        kind: "inngest.warning.sdk.agent.thread.fresh",
      }),
    ]);
  });

  test("a trigger whose path is there joins the thread it names, with no warning", async () => {
    const warn = vi.fn();
    const client = new Inngest({
      id: testClientId,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    const agents = createAgents(client, { store: memoryKvAdapter() });
    let key = "";
    const { fn } = agents.agent(
      {
        id: "joined",
        triggers: [{ event: "shop/order", thread: "event.data.pr" }],
      },
      async ({ me }) => {
        key = me.key;
      },
    );

    await run(fn, { event: { name: "shop/order", data: { pr: "p7" } } });

    expect(key).toBe("p7");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a message after the run ended", () => {
  test("starts a new run on the same thread, which reads the state the first run wrote; another thread does not see it", async () => {
    const store = freshKv();
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "keeper",
        triggers: { event: "shop/order", thread: "event.data.id" },
      },
      async ({ me }) => {
        const before = (await store.thread.get("note")) ?? null;

        await store.thread.set("note", `written by a run on ${me.key}`);

        return before;
      },
    );
    const send = async (id: string) => {
      return (await run(fn, { event: { name: "shop/order", data: { id } } }))
        .output;
    };

    expect(await send("o1")).toBeNull();
    expect(await send("o1")).toBe("written by a run on o1");
    expect(await send("o2")).toBeNull();
  });
});

describe("recovery", () => {
  test("a run that recovery resumed gets the event of the run that failed, and the inbox opens with it", async () => {
    const agents = createAgents(makeClient(), { store: memoryKvAdapter() });
    const { fn } = agents.agent(
      {
        id: "recovers",
        triggers: [{ event: "shop/order", thread: "event.data.id" }],
        recovery: true,
      },
      async ({ event, inbox }) => {
        const first = await inbox.next();

        return { event: [event.name, event.data], first: first?.name };
      },
    );

    const { output } = await run(fn, {
      event: {
        name: "agent/recover",
        data: {
          agent: `${testClientId}/recovers`,
          thread: "o1",
          event: { id: "evt-1", name: "shop/order", data: { id: "o1" } },
        },
      },
    });

    expect(output).toEqual({
      event: ["shop/order", { id: "o1" }],
      first: "shop/order",
    });
  });
});
