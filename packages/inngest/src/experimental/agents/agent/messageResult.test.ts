/**
 * @module
 * `message().result()`: the agent's finished function tells the sender of
 * every message a run took how the run ended, with one `agent/message.result`
 * per message, so the sender can match `async.data.id == "<id>"`.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { freshKv, run } from "./test-helpers.ts";

const trigger = (id: string) => {
  return {
    id,
    name: "agent/message",
    data: {
      agent: `${testClientId}/bot`,
      thread: "t1",
      content: "build it",
    },
  };
};

const setup = (recovery = false) => {
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

  freshKv();

  const agent = createAgentFunction(
    client,
    { id: "bot", ...(recovery && { recovery: true }) },
    async () => {},
  );

  return { agent, sent };
};

const finished = (
  start: ReturnType<typeof trigger>,
  extra: Record<string, unknown>,
) => {
  return {
    name: "inngest/function.finished",
    data: {
      function_id: `${testClientId}-bot`,
      run_id: "r1",
      events: [start],
      event: start,
      ...extra,
    },
  };
};

describe("the finished function tells the sender of the message that started the run", () => {
  test("a completed run sends its output, with the message's id", async () => {
    const { agent, sent } = setup();

    await run(agent.finished, {
      event: finished(trigger("m1"), {
        _inngest: { status: "Completed" },
        result: "built",
      }),
    });

    expect(sent).toMatchObject([
      {
        name: "agent/message.result",
        data: { id: "m1", run_id: "r1", status: "completed", output: "built" },
      },
    ]);
  });

  test("a failed run sends the error", async () => {
    const { agent, sent } = setup();

    await run(agent.finished, {
      event: finished(trigger("m2"), {
        _inngest: { status: "Failed" },
        error: { name: "Error", message: "boom" },
      }),
    });

    expect(sent).toMatchObject([
      {
        name: "agent/message.result",
        data: { id: "m2", run_id: "r1", status: "failed", error: "boom" },
      },
    ]);
  });

  test("a stopped run says so", async () => {
    const { agent, sent } = setup();

    await run(agent.finished, {
      event: finished(trigger("m3"), { _inngest: { status: "Cancelled" } }),
    });

    expect(sent).toMatchObject([
      {
        name: "agent/message.result",
        data: { id: "m3", run_id: "r1", status: "stopped" },
      },
    ]);
  });

  test("a run that started from another event sends nothing", async () => {
    const { agent, sent } = setup();

    await run(agent.finished, {
      event: finished(
        { ...trigger("m4"), name: "chat/message" },
        { _inngest: { status: "Completed" } },
      ),
    });

    expect(sent).toEqual([]);
  });
});

describe("with recovery", () => {
  test("a failure that recovery resumes is not reported: the resumed run reports it", async () => {
    const { agent, sent } = setup(true);

    await run(agent.finished, {
      event: finished(trigger("m4"), {
        _inngest: { status: "Failed" },
        error: { name: "Error", message: "boom" },
      }),
    });

    expect(
      sent.map((event) => {
        return event.name;
      }),
    ).toEqual(["agent/recover"]);
  });

  test("a run that recovery started reports under the id of the message it resent", async () => {
    const { agent, sent } = setup(true);
    const resent = {
      id: "evt-recover",
      name: "agent/recover",
      data: {
        agent: `${testClientId}/bot`,
        thread: "t1",
        event: trigger("m5"),
      },
    };

    await run(agent.finished, {
      event: finished(resent as never, {
        _inngest: { status: "Completed" },
        result: "ok",
      }),
    });

    expect(sent).toMatchObject([
      {
        name: "agent/message.result",
        data: { id: "m5", status: "completed", output: "ok" },
      },
    ]);
  });
});
