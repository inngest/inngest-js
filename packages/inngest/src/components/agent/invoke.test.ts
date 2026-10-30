/**
 * @module
 * Tests for `agent.invoke()`: the invoke op it creates, with the session,
 * thread and depth the callee is started with.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgents } from "./agents.ts";
import {
  AgentCancelledError,
  agentInvokeCancelOn,
  agentInvokeDepth,
  agentInvokeInput,
} from "./invoke.ts";
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

describe("agent.invoke limits", () => {
  const withLimits = (limits: Record<string, unknown>) => {
    return {
      name: "foo",
      data: { _agent: { depth: 1, limits } },
    };
  };

  test("refuses a call the inherited limits do not allow, with a message", async () => {
    await expect(
      found(
        () => {
          return agent.invoke("team/leaf");
        },
        withLimits({ depth: 0 }),
      ),
    ).rejects.toThrow(/team\/leaf was not started/);
  });

  test("passes the narrowed limits to the agent it starts", async () => {
    const steps = await found(
      () => {
        return agent.invoke("team/leaf");
      },
      withLimits({ depth: 2, mayCall: [["team/*"]] }),
    );

    expect(steps[0]?.opts).toMatchObject({
      payload: {
        data: {
          _agent: { depth: 2, limits: { depth: 1, mayCall: [["team/*"]] } },
        },
      },
    });
  });
});

describe("agent.invoke cancellation", () => {
  const cancelledFinish = {
    name: "inngest/function.finished",
    data: {
      _inngest: { status: "Cancelled" },
      function_id: "team-researcher",
      run_id: "child-run",
    },
  };

  // Runs a caller whose invoke step already has `data`, and returns what the
  // call did.
  const settled = async (data: unknown) => {
    const client = new Inngest({ id: testClientId });
    let outcome: { value?: unknown; error?: unknown } = {};
    const fn = client.createFunction(
      { id: "caller", triggers: [{ event: "foo" }] },
      async () => {
        try {
          outcome = { value: await agent.invoke("team/researcher", {}) };
        } catch (error) {
          outcome = { error };
        }
      },
    );
    const first = await runFnWithStack(fn, {});

    if (first.type !== "steps-found") {
      throw new Error(`unexpected ${first.type}`);
    }

    const id = first.steps[0]?.id as string;

    await runFnWithStack(fn, { [id]: { id, data } });

    return outcome;
  };

  test("a cancelled callee throws AgentCancelledError with its run", async () => {
    const { error } = await settled(cancelledFinish);

    expect(error).toBeInstanceOf(AgentCancelledError);
    expect(error).toMatchObject({
      name: "AgentCancelledError",
      functionId: "team-researcher",
      runId: "child-run",
    });
    expect((error as Error).message).toContain("team/researcher");
  });

  test("an output is returned as it is, whatever its shape", async () => {
    for (const output of [
      "text",
      null,
      { answer: 1 },
      { name: "inngest/function.finished", data: { _inngest: {} } },
    ]) {
      expect((await settled(output)).value).toEqual(output);
    }
  });

  test("tells the callee which run invoked it", async () => {
    const steps = await found(() => {
      return agent.invoke("team/researcher", {});
    });

    expect(steps[0]?.opts).toMatchObject({
      payload: { data: { _agent: { parent: "run" } } },
    });
  });

  test("an agent takes the parent cancel entry through its own cancelOn", () => {
    const client = new Inngest({ id: testClientId });
    const agents = createAgents(client);

    agents.agent(
      { id: "worker", cancelOn: [agentInvokeCancelOn] },
      async () => {
        return "done";
      },
    );
    agents.agent({ id: "plain" }, async () => {
      return "done";
    });

    const configs = agents.functions().map((fn) => {
      return JSON.stringify(
        fn["getConfig"]({ baseUrl: new URL("http://x"), appPrefix: "a" }),
      );
    });
    const withEntry = configs.filter((config) => {
      return config.includes(JSON.stringify(agentInvokeCancelOn.if));
    });

    expect(withEntry).toHaveLength(1);
    expect(withEntry[0]).toContain("worker");
  });
});
