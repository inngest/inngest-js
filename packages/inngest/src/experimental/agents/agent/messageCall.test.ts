/**
 * @module
 * `thread.message(content)`: sent at once, and a promise that carries a run
 * you can await. `.result()` resolves with the output of the run that took the
 * message, found through a private inbox opened before the send.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { threadHandle } from "../threads/thread.ts";
import { createAgents } from "./agents.ts";
import { run } from "./test-helpers.ts";

const setup = (body: (thread: ReturnType<typeof threadHandle>) => unknown) => {
  const bodies: { name: string; data: Record<string, unknown>; id?: string }[] =
    [];
  const client = new Inngest({
    id: testClientId,
    eventKey: "key",
    fetch: (async (_url: unknown, init?: { body?: string }) => {
      const sent = JSON.parse(init?.body ?? "null");

      bodies.push(...(Array.isArray(sent) ? sent : [sent]));

      return new Response(JSON.stringify({ ids: ["1"], status: 200 }));
    }) as unknown as typeof fetch,
  });
  const thread = threadHandle(client, `${testClientId}/callee`, "t1");
  const fn = client.createFunction(
    { id: "caller", triggers: [{ event: "go" }] },
    async () => {
      return body(thread);
    },
  );

  return { fn, bodies, client };
};

const go = { name: "go", data: {} };
const options = (extra: object = {}) => {
  return { event: go, key: "msg:r1.0", runId: "r1", ...extra };
};
const result = (data: object) => {
  return {
    name: "agent/message.result",
    data: { id: "msg:r1.0", run_id: "run-9", ...data },
  };
};

describe("thread.message().result()", () => {
  test("one await resolves with the output of the run that took the message", async () => {
    const { fn, bodies } = setup(async (thread) => {
      return await thread.message("y").result();
    });
    const { output } = await run(
      fn,
      options({
        incoming: [result({ status: "completed", output: { n: 1 } })],
      }),
    );

    expect(output).toEqual({ n: 1 });
    expect(bodies).toMatchObject([
      {
        id: "msg:r1.0",
        name: "agent/message",
        data: {
          agent: `${testClientId}/callee`,
          thread: "t1",
          content: "y",
          from: { kind: "function", key: "r1" },
        },
      },
    ]);
  });

  test("the awaited call is a run handle with a result", async () => {
    const { fn } = setup(async (thread) => {
      const call = await thread.message("y");

      return await call.result();
    });
    const { output } = await run(
      fn,
      options({ incoming: [result({ status: "completed", output: "done" })] }),
    );

    expect(output).toBe("done");
  });

  test("a message called without await in an agent is still sent", async () => {
    const { client, bodies } = setup(async () => {});
    const agents = createAgents(client, { store: memoryKvAdapter() });
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      callee.thread("t9").message("y");

      return "returned";
    });
    const { output } = await run(caller.fn, {
      event: {
        name: "agent/message",
        data: { agent: `${testClientId}/caller`, thread: "c1", content: "go" },
      },
    });

    expect(output).toBe("returned");
    expect(bodies).toMatchObject([
      { name: "agent/message", data: { thread: "t9", content: "y" } },
    ]);
  });

  test("a failed run throws its error", async () => {
    const { fn } = setup(async (thread) => {
      try {
        await thread.message("y").result();
      } catch (error) {
        return (error as Error).message;
      }

      return "no throw";
    });
    const { output } = await run(
      fn,
      options({ incoming: [result({ status: "failed", error: "boom" })] }),
    );

    expect(output).toBe("boom");
  });

  test("a stopped run throws a stopped error", async () => {
    const { fn } = setup(async (thread) => {
      try {
        await thread.message("y").result();
      } catch (error) {
        return (error as Error).name;
      }

      return "no throw";
    });
    const { output } = await run(
      fn,
      options({ incoming: [result({ status: "stopped" })] }),
    );

    expect(output).toBe("AgentStoppedError");
  });

  test("result({ timeout }) throws a timeout error when nothing arrives", async () => {
    const { fn } = setup(async (thread) => {
      try {
        await thread.message("y").result({ timeout: "1s" });
      } catch (error) {
        return (error as Error).name;
      }

      return "no throw";
    });
    const { output } = await run(fn, options({ timeouts: 1 }));

    expect(output).toBe("AgentTimeoutError");
  });

  test("a timeout asked for after the call was awaited still times out", async () => {
    const { fn } = setup(async (thread) => {
      const call = await thread.message("y");

      try {
        await call.result({ timeout: "1s" });
      } catch (error) {
        return (error as Error).name;
      }

      return "no throw";
    });
    const { output } = await run(fn, options({ timeouts: 1 }));

    expect(output).toBe("AgentTimeoutError");
  });

  test("costs 2 steps for the message and none for a result that already arrived", async () => {
    const { fn } = setup(async (thread) => {
      return await thread.message("y").result();
    });
    const steps: string[] = [];
    const { ops } = await run(
      fn,
      options({
        incoming: [result({ status: "completed", output: 1 })],
        onStep: (op: { displayName?: string }) => {
          steps.push(op.displayName ?? "");
        },
      }),
    );

    // The open and the send are the two steps; the one read finds the result.
    expect(
      ops.map((op) => {
        return op.op;
      }),
    ).toEqual(["open", "wait"]);
    expect(steps).toHaveLength(1);
  });
});
