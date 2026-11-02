/**
 * @module
 * `agent.start()`: the code side of calling an agent. A call opens a thread
 * with a generated key, sends the input with a sender that carries the chain
 * depth, and returns a handle whose `result()` is the callee's output.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { createAgents } from "./agents.ts";
import { run } from "./test-helpers.ts";

const makeAgents = () => {
  return createAgents(new Inngest({ id: testClientId }), {
    store: memoryKvAdapter(),
  });
};

describe("agent.start()", () => {
  test("a plain agent gets an agent/message with the content and a sender", async () => {
    const agents = makeAgents();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      const started = await callee.start("do it");

      return started.key;
    });
    const sent: unknown[] = [];
    const { output } = await run(caller.fn, {
      event: {
        name: "agent/message",
        data: { agent: `${testClientId}/caller`, thread: "c1", content: "go" },
      },
      onInvoke: (op) => {
        sent.push(op.opts);

        return { data: "done" };
      },
    });

    expect(typeof output).toBe("string");
    expect(sent).toMatchObject([
      {
        payload: {
          data: {
            agent: `${testClientId}/callee`,
            thread: output,
            content: "do it",
            from: {
              kind: "agent",
              address: `${testClientId}/caller`,
              key: "c1",
              depth: 1,
              thread: output,
            },
          },
        },
      },
    ]);
  });
});

describe("start().result()", () => {
  const event = (name: string) => {
    return {
      name: "agent/message",
      data: { agent: `${testClientId}/${name}`, thread: "c1", content: "go" },
    };
  };

  test("result resolves with the callee's output, in one await", async () => {
    const agents = makeAgents();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      return await callee.start("do it").result();
    });
    const { output } = await run(caller.fn, {
      event: event("caller"),
      onInvoke: () => {
        return { data: { answer: 42 } };
      },
    });

    expect(output).toEqual({ answer: 42 });
  });

  test("several starts in parallel each get their own thread", async () => {
    const agents = makeAgents();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      const results = await Promise.all([
        callee.start("a").result(),
        callee.start("b").result(),
        callee.start("c").result(),
      ]);
      const keys = await Promise.all([callee.start("d")]);

      return [results, keys.length];
    });
    const threads: string[] = [];
    const { output } = await run(caller.fn, {
      event: event("caller"),
      onInvoke: (op) => {
        const data = (op.opts as { payload: { data: Record<string, string> } })
          .payload.data;

        threads.push(data.thread as string);

        return { data: data.content };
      },
    });

    expect(output).toEqual([["a", "b", "c"], 1]);
    expect(new Set(threads).size).toBe(threads.length);
  });

  test("result throws when the callee failed", async () => {
    const agents = makeAgents();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      try {
        await callee.start("x").result();
      } catch (error) {
        return (error as Error).message;
      }

      return "no throw";
    });
    const { output } = await run(caller.fn, {
      event: event("caller"),
      onInvoke: () => {
        return { error: { name: "Error", message: "boom" } };
      },
    });

    expect(output).toBe("boom");
  });

  test("result throws a stopped error for a cancelled run", async () => {
    const agents = makeAgents();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      try {
        await callee.start("x").result();
      } catch (error) {
        return (error as Error).name;
      }

      return "no throw";
    });
    const { output } = await run(caller.fn, {
      event: event("caller"),
      onInvoke: () => {
        return {
          data: {
            name: "inngest/function.finished",
            data: { _inngest: { status: "Cancelled" }, run_id: "r1" },
          },
        };
      },
    });

    expect(output).toBe("AgentStoppedError");
  });

  test("start outside a function throws", () => {
    const callee = makeAgents().agent({ id: "callee" });

    expect(() => {
      return callee.start("x");
    }).toThrow(/inside an Inngest function/);
  });

  test("the callee's address and id are on the agent", () => {
    const callee = makeAgents().agent({ id: "callee" });

    expect(callee.id).toBe("callee");
    expect(callee.address).toBe(`${testClientId}/callee`);
  });
});

describe("start() limits", () => {
  const event = {
    name: "agent/message",
    data: {
      agent: `${testClientId}/caller`,
      thread: "c1",
      content: "go",
      from: { depth: 1, limits: { depth: 0 } },
    },
  };

  test("a chain longer than limits.depth is refused with a readable error", async () => {
    const agents = makeAgents();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      try {
        await callee.start("x");
      } catch (error) {
        return (error as Error).message;
      }

      return "started";
    });
    const { output } = await run(caller.fn, { event });

    expect(output).toContain("was not started");
    expect(output).toContain("limits.depth");
  });

  test("the depth comes from data.from and grows by one for the callee", async () => {
    const agents = makeAgents();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      await callee.start("x");
    });
    const sent: unknown[] = [];

    await run(caller.fn, {
      event: {
        ...event,
        data: { ...event.data, from: { depth: 2, limits: { depth: 3 } } },
      },
      onInvoke: (op) => {
        sent.push(op.opts);

        return { data: null };
      },
    });

    expect(sent).toMatchObject([
      {
        payload: {
          data: { from: { depth: 3, limits: { depth: 2 } } },
        },
      },
    ]);
  });
});
