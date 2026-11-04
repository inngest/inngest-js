/**
 * @module
 * `agent.start()`: the code side of calling an agent. A start opens a new
 * thread with a generated key and sends the input as a message to it, with a
 * sender that carries the chain depth; the result comes back to a private inbox
 * opened before the send, so no step waits for the child.
 */
import { z } from "zod";
import { Inngest } from "../../../components/Inngest.ts";
import { invoke } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { createAgents } from "./agents.ts";
import { mintGrant, proofOf, verifyGrant } from "./grant.ts";
import { run } from "./test-helpers.ts";

type Sent = { id?: string; name: string; data: Record<string, unknown> };

const setup = () => {
  const sent: Sent[] = [];
  const client = new Inngest({
    id: testClientId,
    eventKey: "key",
    fetch: (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "null");

      // The fake executor can run a step twice; an event is sent once per id.
      for (const event of Array.isArray(body) ? body : [body]) {
        if (
          !sent.some((seen) => seen.id !== undefined && seen.id === event.id)
        ) {
          sent.push(event);
        }
      }

      return new Response(JSON.stringify({ ids: ["1"], status: 200 }));
    }) as unknown as typeof fetch,
  });
  const agents = createAgents(client, { store: memoryKvAdapter() });

  return { agents, client, sent };
};

const trigger = (name: string) => {
  return {
    name: "agent/message",
    data: { agent: `${testClientId}/${name}`, thread: "c1", content: "go" },
  };
};

const resultFor = (data: object) => {
  return {
    name: "agent/message.result",
    data: { id: "msg:r1.0", run_id: "run-9", ...data },
  };
};

describe("agent.start()", () => {
  test("a plain agent gets an agent/message with the content and a sender", async () => {
    const { agents, sent } = setup();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      const started = await callee.start("do it");

      return started.key;
    });
    const { output } = await run(caller.fn, { event: trigger("caller") });

    expect(typeof output).toBe("string");
    expect(
      sent.filter((event) => event.name === "agent/message"),
    ).toMatchObject([
      {
        id: expect.stringMatching(/^msg:/),
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
    ]);
  });

  test("the thread key leads with the agent's address", async () => {
    const { agents } = setup();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      return (await callee.start("x")).key;
    });
    const { output } = await run(caller.fn, { event: trigger("caller") });

    expect(output).toMatch(new RegExp(`^${testClientId}/callee:`));
  });

  test("several starts get their own threads and none waits for the child", async () => {
    const { agents, sent } = setup();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      const first = await callee.start("a");
      const second = await callee.start("b");
      const third = await callee.start("c");

      return [first.key, second.key, third.key];
    });
    const { output } = await run(caller.fn, { event: trigger("caller") });
    const threads = sent
      .filter((event) => event.name === "agent/message")
      .map((event) => event.data.thread);

    expect(new Set(output as string[]).size).toBe(3);
    expect(threads.sort()).toEqual([...(output as string[])].sort());
  });

  test("start outside a function throws", () => {
    const callee = setup().agents.agent({ id: "callee" });

    expect(() => {
      return callee.start("x");
    }).toThrow(/inside an Inngest function/);
  });

  test("the callee's address and id are on the agent", () => {
    const callee = setup().agents.agent({ id: "callee" });

    expect(callee.id).toBe("callee");
    expect(callee.address).toBe(`${testClientId}/callee`);
  });

  test("an agent that has an invoke() trigger gets the typed input as the message content", async () => {
    const { agents, sent } = setup();
    const { z } = await import("zod");
    const { invoke } = await import("../../../components/triggers/triggers.ts");
    const typed = agents.agent({
      id: "typed",
      triggers: invoke(z.object({ q: z.string() })),
    });
    const caller = agents.agent({ id: "caller" }, async () => {
      await typed.start({ q: "why" });
    });

    await run(caller.fn, { event: trigger("caller") });

    expect(
      sent.filter((event) => event.name === "agent/message"),
    ).toMatchObject([
      { data: { content: { q: "why" }, from: { typed: true } } },
    ]);
  });
});

// A plain function has no inbox of its own, so the test helper's one inbox is
// the private one the start opened.
describe("start().result()", () => {
  const caller = (
    body: (
      callee: ReturnType<ReturnType<typeof setup>["agents"]["agent"]>,
    ) => unknown,
  ) => {
    const made = setup();
    const callee = made.agents.agent({ id: "callee" });
    const fn = made.client.createFunction(
      { id: "plain", triggers: [{ event: "go" }] },
      async () => {
        return body(callee);
      },
    );

    return { fn, ...made };
  };
  const options = (extra: object = {}) => {
    return {
      event: { name: "go", data: {} },
      key: "msg:r1.0",
      runId: "r1",
      ...extra,
    };
  };

  test("resolves with the callee's output, in one await", async () => {
    const { fn } = caller(async (callee) => {
      return await callee.start("do it").result();
    });
    const { output } = await run(
      fn,
      options({
        incoming: [resultFor({ status: "completed", output: { n: 1 } })],
      }),
    );

    expect(output).toEqual({ n: 1 });
  });

  test("throws when the callee failed", async () => {
    const { fn } = caller(async (callee) => {
      try {
        await callee.start("x").result();
      } catch (error) {
        return (error as Error).message;
      }

      return "no throw";
    });
    const { output } = await run(
      fn,
      options({ incoming: [resultFor({ status: "failed", error: "boom" })] }),
    );

    expect(output).toBe("boom");
  });

  test("throws a stopped error for a stopped run", async () => {
    const { fn } = caller(async (callee) => {
      try {
        await callee.start("x").result();
      } catch (error) {
        return (error as Error).name;
      }

      return "no throw";
    });
    const { output } = await run(
      fn,
      options({ incoming: [resultFor({ status: "stopped" })] }),
    );

    expect(output).toBe("AgentStoppedError");
  });

  test("a timeout works on an awaited handle, called late", async () => {
    const { fn } = caller(async (callee) => {
      const started = await callee.start("slow");

      try {
        await started.result({ timeout: "1s" });
      } catch (error) {
        return (error as Error).name;
      }

      return "no throw";
    });
    const { output } = await run(fn, options({ timeouts: 1 }));

    expect(output).toBe("AgentTimeoutError");
  });

  test("a second result() after a timeout keeps waiting for the same run", async () => {
    const { fn } = caller(async (callee) => {
      const started = await callee.start("slow");
      const first = await started.result({ timeout: "1s" }).catch((error) => {
        return (error as Error).name;
      });

      return [first, await started.result()];
    });
    const { output } = await run(
      fn,
      options({
        timeouts: 1,
        incoming: [resultFor({ status: "completed", output: "late" })],
      }),
    );

    expect(output).toEqual(["AgentTimeoutError", "late"]);
  });
});

describe("start() limits", () => {
  // The start the caller runs for: another agent's start, with one grant that
  // carries what it passes down (`depth=` lines).
  const startedWith = (depth: number, from: number) => {
    const client = new Inngest({ id: testClientId });
    const grant = mintGrant(client, {
      thread: "c1",
      restrict: [`depth=${depth}`],
      lines: [`iss=${testClientId}`],
    });

    return {
      id: "e1",
      name: "agent/message",
      data: {
        agent: `${testClientId}/caller`,
        thread: "c1",
        content: "go",
        from: { depth: from, thread: "c1" },
        "::agents": proofOf(client, grant, "e1", "c1"),
      },
    };
  };
  const event = startedWith(0, 1);

  test("a chain longer than limits.depth is refused with a readable error", async () => {
    const { agents } = setup();
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
    const { agents, sent } = setup();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      await callee.start("x");
    });

    await run(caller.fn, { event: startedWith(3, 2) });

    const message = sent.find((e) => e.name === "agent/message");
    const carried = message?.data["::agents"] as {
      grant: { lines: string[] };
    };

    expect(message?.data.from).toMatchObject({ depth: 3 });
    // The callee's grant follows the caller's and lowers the depth.
    expect(carried.grant.lines).toContain("depth=3");
    expect(carried.grant.lines).toContain("depth=2");
  });

  test("nothing of the starter's budget is handed to the thread it starts", async () => {
    const { agents, sent } = setup();
    const callee = agents.agent({ id: "callee", budget: { tokens: 100000 } });
    const caller = agents.agent(
      { id: "caller", budget: { tokens: 5 } },
      async () => {
        await callee.start("x");
      },
    );

    await run(caller.fn, { event: startedWith(2, 1) });

    const message = sent.find((e) => e.name === "agent/message");
    const grant = verifyGrant(
      new Inngest({ id: testClientId }),
      (message?.data["::agents"] as { grant: unknown }).grant,
      message?.data.thread as string,
    );

    expect(grant?.limits).toEqual({ depth: 1 });
    expect(message?.data.from).not.toHaveProperty("limits");
  });
});

describe("start() without await", () => {
  test("a start nobody awaits is still sent before the agent returns", async () => {
    const { agents, sent } = setup();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      callee.start("fire and forget");

      return "returned";
    });
    const { output } = await run(caller.fn, { event: trigger("caller") });

    expect(output).toBe("returned");
    expect(sent.filter((e) => e.name === "agent/message")).toMatchObject([
      { data: { content: "fire and forget" } },
    ]);
  });
});

describe("a typed start is checked by the child (L101)", () => {
  const make = () => {
    const { agents } = setup();
    let ran = 0;
    const typed = agents.agent(
      { id: "typed", triggers: invoke(z.object({ q: z.string() })) },
      async ({ event }) => {
        ran += 1;

        return event.data.q;
      },
    );

    return { typed, ran: () => ran };
  };
  const startMessage = (content: unknown) => {
    return {
      name: "agent/message",
      data: {
        agent: `${testClientId}/typed`,
        thread: "t1",
        content,
        from: {
          kind: "function",
          id: "caller",
          key: "r1",
          depth: 1,
          typed: true,
        },
      },
    };
  };

  test("an input that breaks the schema fails the run with a non-retriable error that names the problem", async () => {
    const { typed, ran } = make();

    await expect(
      run(typed.fn, { event: startMessage({ q: 1 }) }),
    ).resolves.toMatchObject({
      error: expect.objectContaining({
        name: "NonRetriableError",
        message: expect.stringContaining("q"),
      }),
    });
    expect(ran()).toBe(0);
  });

  test("a valid input reaches the handler as the trigger's data", async () => {
    const { typed, ran } = make();
    const { output } = await run(typed.fn, {
      event: startMessage({ q: "why" }),
    });

    expect(output).toBe("why");
    expect(ran()).toBeGreaterThan(0);
  });
});
