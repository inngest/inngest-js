/**
 * @module
 * Tests for `agent.invoke()`: the invoke op it creates, with the session,
 * thread and depth the callee is started with.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { agentInvokeDepth, agentInvokeInput } from "./invoke.ts";
import { agent } from "./loop.ts";

const found = async (
  call: () => Promise<unknown>,
  event: { name: string; data: Record<string, unknown>; meta?: unknown } = {
    name: "foo",
    data: {},
  },
) => {
  const client = new Inngest({ id: testClientId });
  const fn = client.createFunction(
    { id: "caller", triggers: [{ event: "foo" }] },
    async () => {
      await call();
    },
  );
  const result = await runFnWithStack(fn, {}, { event: event as never });

  if (result.type === "function-rejected") {
    throw new Error(JSON.stringify((result as { error?: unknown }).error));
  }

  if (result.type !== "steps-found") {
    throw new Error(`unexpected ${result.type}`);
  }

  return result.steps;
};

describe("agent.invoke", () => {
  test("invokes appId/functionId with a new thread, a session and depth 1", async () => {
    const steps = await found(() => {
      return agent.invoke("team/researcher", { question: "why" });
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]?.op).toBe("InvokeFunction");
    expect(steps[0]?.opts).toMatchObject({
      function_id: "team-researcher",
      payload: {
        data: { question: "why", _agent: { depth: 1 } },
        meta: {
          sessions: {
            agent_session: "run",
            agent_thread: "researcher:run.0",
          },
        },
      },
    });
  });

  test("keeps the caller's session and counts depth from its event", async () => {
    const steps = await found(
      () => {
        return agent.invoke("team/researcher", {}, { thread: "r:1" });
      },
      {
        name: "foo",
        data: { _agent: { depth: 2 } },
        meta: {
          sessions: { agent_session: "slack:C1", agent_thread: "box:1" },
        },
      },
    );

    expect(steps[0]?.opts).toMatchObject({
      payload: {
        data: { _agent: { depth: 3 } },
        meta: { sessions: { agent_session: "slack:C1", agent_thread: "r:1" } },
      },
    });
  });

  test("gives each call of a run its own thread", async () => {
    const steps = await found(() => {
      return Promise.all([
        agent.invoke("team/a", {}, { id: "one" }),
        agent.invoke("team/a", {}, { id: "two" }),
      ]);
    });
    const threads = steps.map((s) => {
      return (
        s.opts as { payload: { meta: { sessions: { agent_thread: string } } } }
      ).payload.meta.sessions.agent_thread;
    });

    expect(threads).toEqual(["a:run.0", "a:run.1"]);
  });

  test("rejects a target that is not appId/functionId", async () => {
    for (const target of ["researcher", "/researcher", "team/"]) {
      await expect(
        found(() => {
          return agent.invoke(target);
        }),
      ).rejects.toThrow(/appId\/functionId/);
    }
  });
});

describe("agent invoke helpers", () => {
  test("read the depth and the input without changing the event", () => {
    const event = { data: { q: 1, _agent: { depth: 2 } } };

    expect(agentInvokeDepth(event)).toBe(2);
    expect(agentInvokeInput(event)).toEqual({ q: 1 });
    expect(event.data._agent).toEqual({ depth: 2 });
    expect(agentInvokeDepth({ data: { q: 1 } })).toBe(0);
  });
});
