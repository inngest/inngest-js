/**
 * @module
 * The pure rules of recovery: the same failure has the same fingerprint, a
 * turn is resent once and a second identical failure stops it, deciding a run
 * twice gives the same answer, and the executor's finished event is read for
 * how the run ended.
 */

import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { markThreadIdle } from "../threads/threadState.ts";
import { createAgentFunction } from "./agentFunction.ts";
import {
  decide,
  fingerprint,
  finishedOf,
  type LastRun,
  summarize,
  turnOf,
} from "./recovery.ts";
import { freshKv, run } from "./test-helpers.ts";

const refusal = (id: string) => {
  return `400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice is not supported for this model."},"request_id":"${id}"}`;
};

const failed = (
  runId: string,
  error: string,
  turn = "t",
  resume = true,
): Parameters<typeof decide>[1] => {
  return {
    runId,
    at: 1,
    error: summarize(error),
    fingerprint: fingerprint("Error", error),
    turn,
    resume,
  };
};

describe("summarize and fingerprint", () => {
  test("one line, no request id", () => {
    expect(summarize(refusal("req_1"))).toBe(
      "tool_choice is not supported for this model.",
    );
    expect(summarize("first line\nsecond line")).toBe("first line");
    expect(summarize(new Error("boom"))).toBe("boom");
  });

  test("the same failure has one fingerprint however its ids and numbers change", () => {
    expect(fingerprint("Error", refusal("req_aaa111"))).toBe(
      fingerprint("Error", refusal("req_bbb222")),
    );
    expect(fingerprint("Error", "timed out after 30 seconds")).toBe(
      fingerprint("Error", "timed out after 45 seconds"),
    );
    expect(fingerprint("Error", "one thing")).not.toBe(
      fingerprint("Error", "another thing"),
    );
  });
});

describe("decide", () => {
  test("a first failure of a turn is resumed", () => {
    const decision = decide(undefined, failed("r1", "boom"));

    expect(decision).toMatchObject({ resuming: true, repeated: false });
    expect(decision.last).toMatchObject({
      status: "failed",
      recovery: "resumed",
      error: "boom",
    });
  });

  test("the same error failing the same turn again is stuck", () => {
    const first = decide(undefined, failed("r1", "boom")).last;
    const second = decide(first, failed("r2", "boom"));

    expect(second).toMatchObject({ resuming: false, repeated: true });
    expect(second.last.recovery).toBe("stuck");
  });

  test("a different error on the same turn is resumed, up to three kinds", () => {
    let last: LastRun | undefined;

    for (const [n, error] of ["a", "b", "c"].entries()) {
      const decision = decide(last, failed(`r${n}`, error));

      expect(decision.resuming).toBe(true);
      last = decision.last;
    }

    expect(decide(last, failed("r9", "d")).resuming).toBe(false);
  });

  test("a different turn starts the guard over", () => {
    const first = decide(undefined, failed("r1", "boom", "turn-a")).last;

    expect(decide(first, failed("r2", "boom", "turn-b")).resuming).toBe(true);
  });

  test("deciding the same run again gives the answer it already got", () => {
    const first = decide(undefined, failed("r1", "boom")).last;
    const again = decide(first, failed("r1", "boom"));

    expect(again.last).toEqual(first);
    expect(again.resuming).toBe(true);

    const stuck = decide(first, failed("r2", "boom")).last;

    expect(decide(stuck, failed("r2", "boom")).last).toEqual(stuck);
  });

  test("with resume off nothing is resent", () => {
    const decision = decide(undefined, failed("r1", "boom", "t", false));

    expect(decision.resuming).toBe(false);
    expect(decision.last.recovery).toBeUndefined();
  });
});

describe("finishedOf", () => {
  test("reads the status and the error of the executor's event", () => {
    expect(finishedOf({ _inngest: { status: "Completed" } })).toEqual({
      status: "completed",
    });
    expect(finishedOf({ _inngest: { status: "Cancelled" } })).toEqual({
      status: "cancelled",
    });
    expect(
      finishedOf({
        _inngest: { status: "Failed" },
        error: { name: "Error", message: "boom" },
      }),
    ).toEqual({
      status: "failed",
      error: { name: "Error", message: "boom", nonRetriable: false },
    });
  });

  test("a turn is named by its message", () => {
    expect(turnOf({ content: "hello" })).toBe(turnOf({ content: "hello" }));
    expect(turnOf({ content: "hello" })).not.toBe(turnOf({ content: "bye" }));
    expect(turnOf({ content: { a: 1 } })).not.toBe(turnOf({ content: "a" }));
  });
});

describe("the finished function", () => {
  const start = {
    name: "agent/message",
    data: {
      agent: `${testClientId}/bot`,
      thread: "t1",
      content: "build it",
    },
  };
  const finishedEvent = (
    runId: string,
    status: string,
    error?: { name: string; message: string },
  ) => {
    return {
      name: "inngest/function.finished",
      data: {
        function_id: `${testClientId}-bot`,
        run_id: runId,
        events: [start],
        event: start,
        _inngest: { status },
        ...(error && { error }),
      },
    };
  };

  const setup = (
    config: Partial<Parameters<typeof createAgentFunction>[1]> = {},
  ) => {
    const sent: { name: string; data: Record<string, unknown>; id?: string }[] =
      [];
    const client = new Inngest({
      id: testClientId,
      eventKey: "key",
      fetch: (async (_url: unknown, init?: { body?: string }) => {
        sent.push(...JSON.parse(init?.body ?? "[]"));

        return new Response(JSON.stringify({ ids: ["1"], status: 200 }));
      }) as unknown as typeof fetch,
    });
    const store = freshKv();
    const agent = createAgentFunction(
      client,
      {
        id: "bot",
        ...config,
      },
      async () => {},
    );
    const lastRun = async () => {
      return (await store
        .with(client)
        .scope("thread", "t1")
        .get(`__lastRun:${testClientId}/bot`)) as LastRun | undefined;
    };

    const seed = async (record: Record<string, unknown>) => {
      await store
        .with(client)
        .scope("thread", "t1")
        .set(`__state:${testClientId}/bot`, {
          status: "idle",
          turn: 0,
          usage: { input: 0, output: 0 },
          ...record,
        });
    };

    return { agent, sent, lastRun, seed, store, client };
  };

  test("is one function of the agent, listening for how its runs end", () => {
    const { agent } = setup();

    expect(agent.finished.id()).toContain("bot-finished");
  });

  test("a completed run is recorded", async () => {
    const { agent, lastRun, sent } = setup({ recovery: true });

    await run(agent.finished, { event: finishedEvent("r1", "Completed") });

    expect(await lastRun()).toMatchObject({
      runId: "r1",
      status: "completed",
    });
    expect(sent).toEqual([]);
  });

  test("a cancelled run is recorded and never resumed", async () => {
    const { agent, lastRun, sent } = setup({ recovery: true });

    await run(agent.finished, { event: finishedEvent("r1", "Cancelled") });

    expect(await lastRun()).toMatchObject({
      runId: "r1",
      status: "cancelled",
    });
    expect(sent).toEqual([]);
  });

  test("a failed run without recovery is recorded with its error and nothing else happens", async () => {
    const { agent, lastRun, sent } = setup();

    await run(agent.finished, {
      event: finishedEvent("r1", "Failed", { name: "Error", message: "boom" }),
    });

    expect(await lastRun()).toMatchObject({
      status: "failed",
      error: "boom",
    });
    expect((await lastRun())?.recovery).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("a failed run with recovery resends the turn once", async () => {
    const { agent, lastRun, sent } = setup({ recovery: true });

    await run(agent.finished, {
      event: finishedEvent("r1", "Failed", { name: "Error", message: "boom" }),
    });

    expect(await lastRun()).toMatchObject({
      status: "failed",
      recovery: "resumed",
    });
    expect(sent).toMatchObject([
      {
        name: "agent/recover",
        id: "recover-r1",
        data: {
          thread: "t1",
          event: { name: "agent/message", data: { content: "build it" } },
        },
      },
    ]);
  });

  test("a run that failed with a NonRetriableError is never resent", async () => {
    const { agent, lastRun, sent } = setup({ recovery: true });

    await run(agent.finished, {
      event: finishedEvent("r1", "Failed", {
        name: "NonRetriableError",
        message: "bad input",
      }),
    });

    expect(await lastRun()).toMatchObject({ status: "failed" });
    expect((await lastRun())?.recovery).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("a plain error that ran out of retries is still resent", async () => {
    const { agent, sent } = setup({ recovery: true });

    await run(agent.finished, {
      event: finishedEvent("r1", "Failed", {
        name: "Error",
        message: "flaky upstream",
      }),
    });

    expect(sent).toMatchObject([{ id: "recover-r1" }]);
  });

  test("an error the executor marked noRetry is not resent either", () => {
    expect(
      finishedOf({
        _inngest: { status: "Failed" },
        error: { name: "Error", message: "x", noRetry: true },
      }).error?.nonRetriable,
    ).toBe(true);
  });

  test("the same error failing the same turn again resends nothing", async () => {
    const { agent, lastRun, sent } = setup({ recovery: true });
    const failure = { name: "Error", message: "boom" };

    await run(agent.finished, {
      event: finishedEvent("r1", "Failed", failure),
    });
    sent.length = 0;
    await run(agent.finished, {
      event: finishedEvent("r2", "Failed", failure),
    });

    expect(await lastRun()).toMatchObject({
      runId: "r2",
      recovery: "stuck",
    });
    expect(sent).toEqual([]);
  });

  test("a run that had answered and was waiting when it failed resends nothing", async () => {
    const { agent, sent, seed, lastRun } = setup({ recovery: true });

    await seed({ status: "waiting", runId: "r1" });
    await run(agent.finished, {
      event: finishedEvent("r1", "Failed", { name: "Error", message: "boom" }),
    });

    expect(sent).toEqual([]);
    expect((await lastRun())?.recovery).toBeUndefined();
  });

  test("the turn in flight is the one resent, not the message that started the run", async () => {
    const { agent, sent, seed } = setup({ recovery: true });

    await seed({
      status: "running",
      runId: "r1",
      inflight: { content: "second" },
    });
    await run(agent.finished, {
      event: finishedEvent("r1", "Failed", { name: "Error", message: "boom" }),
    });

    expect(sent).toMatchObject([
      { data: { event: { data: { content: "second" } } } },
    ]);
  });

  test("a newer run owning the record is not resumed", async () => {
    const { agent, sent, seed } = setup({ recovery: true });
    const newer = "01K00000000000000000000009";
    const older = "01J00000000000000000000001";

    await seed({ status: "running", runId: newer, inflight: { content: "x" } });
    await run(agent.finished, {
      event: finishedEvent(older, "Failed", { name: "Error", message: "boom" }),
    });

    expect(sent).toEqual([]);
  });

  test("a late report for an older run is still said after a newer run ended", async () => {
    const { agent, sent } = setup({ recovery: true });
    const newer = "01K00000000000000000000009";
    const older = "01J00000000000000000000001";

    await run(agent.finished, { event: finishedEvent(newer, "Completed") });
    await run(agent.finished, {
      event: finishedEvent(older, "Failed", { name: "Error", message: "late" }),
    });

    expect(sent).toEqual([]);
  });

  test("the resent turn keeps the event that started the run", async () => {
    const { agent, sent } = setup({
      recovery: true,
      triggers: {
        event: "shop/order",
        thread: "event.data.id",
        message: () => {
          return "order";
        },
      },
    } as never);
    const order = { name: "shop/order", data: { id: "t1" } };

    await run(agent.finished, {
      event: {
        name: "inngest/function.finished",
        data: {
          function_id: `${testClientId}-bot`,
          run_id: "r1",
          events: [order],
          event: order,
          _inngest: { status: "Failed" },
          error: { name: "Error", message: "boom" },
        },
      },
    });

    expect(sent).toMatchObject([
      {
        data: {
          thread: "t1",
          event: { name: "shop/order", data: { id: "t1" } },
        },
      },
    ]);
  });

  test("the cleanup marking the thread idle does not touch lastRun", async () => {
    const { agent, lastRun, seed, store, client } = setup();

    await seed({ status: "waiting", runId: "r1" });
    await run(agent.finished, { event: finishedEvent("r1", "Completed") });
    await run(
      client.createFunction(
        { id: "idle", triggers: [{ event: "x" }] },
        async () => {
          await markThreadIdle(store, `${testClientId}/bot`, "t1", "r1");
        },
      ),
      { event: { name: "x", data: {} } },
    );

    expect(await lastRun()).toMatchObject({ runId: "r1", status: "completed" });
  });

  test("a newer run on the thread is named in what is said", async () => {
    const { agent, seed } = setup({ recovery: true });

    await seed({ status: "running", runId: "01K00000000000000000000009" });
    await run(agent.finished, {
      event: finishedEvent("01J00000000000000000000001", "Failed", {
        name: "Error",
        message: "boom",
      }),
    });
  });

  test("a run that ended before a newer one's record does not overwrite it", async () => {
    const { agent, lastRun } = setup();
    const newer = "01K00000000000000000000009";
    const older = "01J00000000000000000000001";

    await run(agent.finished, { event: finishedEvent(newer, "Completed") });
    await run(agent.finished, {
      event: finishedEvent(older, "Failed", { name: "Error", message: "late" }),
    });

    expect((await lastRun())?.runId).toBe(newer);
  });
});

describe("what the body is told", () => {
  const trigger = {
    name: "agent/message",
    data: {
      agent: `${testClientId}/bot`,
      thread: "t1",
      content: "hi",
    },
  };
  const seeded = async (
    record: Record<string, unknown>,
    body: Parameters<typeof createAgentFunction>[2],
    lastRun?: LastRun,
  ) => {
    const client = new Inngest({ id: testClientId });
    const store = freshKv();

    if (lastRun) {
      await store
        .with(client)
        .scope("thread", "t1")
        .set(`__lastRun:${testClientId}/bot`, lastRun);
    }

    await store
      .with(client)
      .scope("thread", "t1")
      .set(`__state:${testClientId}/bot`, {
        status: "idle",
        turn: 0,
        usage: { input: 0, output: 0 },
        ...record,
      });

    const agent = createAgentFunction(client, { id: "bot" }, body);
    const read = async () => {
      return (await store
        .with(client)
        .scope("thread", "t1")
        .get(`__state:${testClientId}/bot`)) as
        | Record<string, unknown>
        | undefined;
    };

    return { agent, read };
  };
  const previous: LastRun = {
    runId: "old",
    status: "failed",
    at: 5,
    error: "boom",
    recovery: "resumed",
  };

  test("previousRun is how the run before this one ended", async () => {
    const { agent } = await seeded(
      {},
      async (ctx) => {
        return ctx.previousRun;
      },
      previous,
    );

    const { output } = await run(agent.fn, { event: trigger });

    expect(output).toEqual(previous);
  });

  test("previousRun is undefined for a thread no run has ended on", async () => {
    const { agent } = await seeded({}, async (ctx) => {
      return ctx.previousRun ?? "none";
    });

    const { output } = await run(agent.fn, { event: trigger });

    expect(output).toBe("none");
  });

  test("the message in flight is kept until the run waits for the next one", async () => {
    const { agent, read } = await seeded({}, async ({ inbox }) => {
      await inbox.next();
    });

    await run(agent.fn, { event: trigger });

    expect((await read())?.inflight).toEqual({ content: "hi" });
  });

  test("a run that begins without a message does not keep the one the run before it left", async () => {
    const { agent, read } = await seeded(
      { runId: "older-run", inflight: { content: "stale" } },
      async () => {},
    );

    await run(agent.fn, {
      event: {
        name: "agent/recover",
        data: { agent: trigger.data.agent, thread: trigger.data.thread },
      },
    });

    expect((await read())?.inflight).toBeUndefined();
  });

  test("restarts counts the times the run continued in another process", async () => {
    const { agent } = await seeded(
      { runId: "run", host: "another-process", restarts: 1 },
      async (ctx) => {
        return ctx.restarts;
      },
    );

    const { output } = await run(agent.fn, { event: trigger });

    expect(output).toBe(2);
  });

  test("a run that began in this process has no restarts, and a new run starts at zero", async () => {
    const same = await seeded({}, async (ctx) => {
      return ctx.restarts;
    });
    const fresh = await seeded(
      { runId: "older-run", host: "another-process", restarts: 4 },
      async (ctx) => {
        return ctx.restarts;
      },
    );

    expect((await run(same.agent.fn, { event: trigger })).output).toBe(0);
    expect((await run(fresh.agent.fn, { event: trigger })).output).toBe(0);
  });
});
