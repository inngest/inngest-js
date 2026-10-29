/**
 * @module
 * Tests for the function options an agent passes on, the ones it refuses, and
 * the function context its body receives.
 */
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { invoke } from "../triggers/triggers.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { agentInvokeCancelOn } from "./invoke.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { run } from "./test-helpers.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);
const kv = createKv({ adapter: memoryKvAdapter() });

const optionsOf = (fn: { opts?: unknown }) => {
  return (fn as unknown as { ["opts"]: unknown })["opts"] as Record<
    string,
    unknown
  >;
};

describe("function options", () => {
  test("the options a plain function takes are passed on", () => {
    const onFailure = async () => {};
    const cancelOn = [{ event: "app/cancel", match: "data.thread" }];
    const agent = agents.agent(
      {
        id: "opts-1",
        on: { cron: "0 * * * *" },
        name: "Opts one",
        description: "an agent",
        concurrency: { limit: 3, key: "event.data.tenant" },
        retries: 2,
        timeouts: { finish: "1h" },
        cancelOn,
        onFailure,
        idempotency: "event.id",
        rateLimit: { limit: 5, period: "1m" },
        throttle: { limit: 5, period: "1m" },
        priority: { run: "0" },
        kv,
      },
      async () => {},
    );
    const options = optionsOf(agent.fn);

    expect(options.name).toBe("Opts one");
    expect(options.description).toBe("an agent");
    expect(options.concurrency).toEqual({ limit: 3, key: "event.data.tenant" });
    expect(options.retries).toBe(2);
    expect(options.timeouts).toEqual({ finish: "1h" });
    expect(options.cancelOn).toEqual(cancelOn);
    expect(options.onFailure).toBe(onFailure);
    expect(options.idempotency).toBe("event.id");
    expect(options.rateLimit).toEqual({ limit: 5, period: "1m" });
    expect(options.throttle).toEqual({ limit: 5, period: "1m" });
    expect(options.priority).toEqual({ run: "0" });
  });

  test("the agent keeps its id, triggers and singleton per thread", () => {
    const agent = agents.agent(
      { id: "opts-2", on: { cron: "0 * * * *" }, retries: 0, kv },
      async () => {},
    );
    const options = optionsOf(agent.fn);

    expect(options.id).toBe("opts-2");
    expect(options.singleton).toMatchObject({ mode: "skip" });
    expect(options.retries).toBe(0);
    expect(options).not.toHaveProperty("debounce");
  });

  test("options not given are not set", () => {
    const options = optionsOf(
      agents.agent(
        { id: "opts-3", on: { cron: "0 * * * *" }, kv },
        async () => {},
      ).fn,
    );

    expect(options).not.toHaveProperty("concurrency");
    expect(options).not.toHaveProperty("retries");
  });

  test("debounce, batchEvents, singleton and checkpointing are refused", () => {
    for (const option of [
      { debounce: { period: "5s" } },
      { batchEvents: { maxSize: 5, timeout: "5s" } },
      { singleton: { key: "event.data.x", mode: "skip" } },
      { checkpointing: true },
    ]) {
      const [key] = Object.keys(option);

      expect(() => {
        return createAgentFunction(
          client,
          { id: "opts-4", kv, ...option } as never,
          async () => {},
        );
      }).toThrow(`does not take the \`${key}\` option`);
    }

    // Only a type check: the call would throw, so it is never made.
    const typeOnly = () => {
      agents.agent(
        // @ts-expect-error a debounce would drop the messages before the last
        { id: "opts-5", debounce: { period: "5s" } },
        async () => {},
      );
    };

    expect(typeOnly).toBeTypeOf("function");
  });
});

describe("agentInvokeCancelOn", () => {
  const body = async () => {
    return "done";
  };

  test("is refused on an agent whose `on` has a trigger other than invoke()", () => {
    for (const on of [
      { cron: "0 * * * *" },
      { event: "app/go", thread: "event.data.id" },
      [invoke(z.object({})), { cron: "0 * * * *" }],
    ]) {
      expect(() => {
        agents.agent(
          {
            id: "cancel-bad",
            on: on as never,
            cancelOn: [agentInvokeCancelOn],
          },
          body,
        );
      }).toThrow(/agentInvokeCancelOn.*other than/);
    }
  });

  test("is allowed with no `on` or with only invoke() in `on`", () => {
    expect(() => {
      agents.agent(
        { id: "cancel-ok-1", cancelOn: [agentInvokeCancelOn] },
        body,
      );
      agents.agent(
        {
          id: "cancel-ok-2",
          on: invoke(z.object({})),
          cancelOn: [agentInvokeCancelOn],
        },
        body,
      );
    }).not.toThrow();
  });

  test("other cancelOn entries are not affected", () => {
    expect(() => {
      agents.agent(
        {
          id: "cancel-ok-3",
          on: { cron: "0 * * * *" },
          cancelOn: [{ event: "app/stop", match: "data.id" }],
        },
        body,
      );
    }).not.toThrow();
  });
});

describe("function context in the body", () => {
  test("the body gets the function context beside the agent's own, with the agent's event", async () => {
    let seen: Record<string, unknown> = {};
    const { fn } = createAgentFunction(
      client,
      { id: "bot", kv },
      async (context) => {
        seen = context as unknown as Record<string, unknown>;
      },
    );

    await run(fn, {
      event: {
        name: "agent/message",
        data: {
          agent: `${testClientId}/bot`,
          thread: "t1",
          text: "hi",
        },
      },
    });

    for (const name of [
      "step",
      "group",
      "defer",
      "runId",
      "logger",
      "attempt",
      "thread",
      "inbox",
      "control",
      "sandboxes",
      "report",
      "scores",
    ]) {
      expect(seen).toHaveProperty(name);
    }

    expect(typeof seen.runId).toBe("string");
    expect(seen).not.toHaveProperty("events");
    expect(seen.event).toMatchObject({
      name: "agent/message",
      data: { thread: "t1", content: "hi" },
    });
  });

  test("the body's step and defer are the run's own", async () => {
    let ran = "";
    const { fn } = createAgentFunction(
      client,
      { id: "bot", kv },
      async ({ step }) => {
        ran = await step.run("mine", async () => {
          return "from the body";
        });
      },
    );

    await run(fn, {
      event: {
        name: "agent/message",
        data: {
          agent: `${testClientId}/bot`,
          thread: "t1",
          text: "hi",
        },
      },
    });

    expect(ran).toBe("from the body");
  });
});
