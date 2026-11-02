/**
 * @module
 * `thread.ask()` and `answerQuestion()`: a question goes to a thread as an
 * `agent/question`, the asker waits on a private inbox for the `agent/answer`
 * that names it, and a second or late answer is dropped.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { answerQuestion } from "../inbox/answer.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { threadHandle } from "../threads/thread.ts";
import { createAgents } from "./agents.ts";
import { run } from "./test-helpers.ts";

const setup = (
  body: (thread: ReturnType<typeof threadHandle>) => Promise<unknown>,
) => {
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

describe("thread.ask()", () => {
  test("sends an agent/question and returns the text of the answer", async () => {
    const { fn, bodies } = setup(async (thread) => {
      return thread.ask("why?");
    });
    const { output, ops } = await run(fn, {
      event: go,
      key: "ask:r1.0",
      runId: "r1",
      incoming: [
        {
          name: "agent/answer",
          data: { re: "ask:r1.0", outcome: "answered", text: "because" },
        },
      ],
    });

    expect(output).toBe("because");
    expect(bodies).toMatchObject([
      {
        name: "agent/question",
        data: {
          agent: `${testClientId}/callee`,
          thread: "t1",
          id: "ask:r1.0",
          text: "why?",
          from: { kind: "function", key: "r1" },
        },
      },
    ]);
    expect(ops[0]).toMatchObject({ op: "open" });
    expect(JSON.stringify(ops[0]?.opts)).toContain(
      'async.data.re == \\"ask:r1.0\\"',
    );
  });

  test("is null when nobody answers in time", async () => {
    const { fn } = setup(async (thread) => {
      return thread.ask("why?", { timeout: "1s" });
    });
    const { output } = await run(fn, { event: go, runId: "r1", timeouts: 1 });

    expect(output).toBeNull();
  });

  test("is null when the question was refused", async () => {
    const { fn } = setup(async (thread) => {
      return thread.ask("why?");
    });
    const { output } = await run(fn, {
      event: go,
      key: "ask:r1.0",
      runId: "r1",
      incoming: [
        { name: "agent/answer", data: { re: "ask:r1.0", outcome: "refused" } },
      ],
    });

    expect(output).toBeNull();
  });

  test("outside a function it throws", async () => {
    const { client } = setup(async () => {});
    const thread = threadHandle(client, `${testClientId}/callee`, "t1");

    await expect(thread.ask("why?")).rejects.toThrow(
      /inside an Inngest function/,
    );
  });
});

describe("answerQuestion()", () => {
  const question = {
    data: {
      id: "q1",
      text: "why?",
      from: { kind: "agent", address: "app/boss", key: "b1", depth: 1 },
    },
  } as const;

  test("sends the answer to the asking agent's thread under the deterministic event id", async () => {
    const { client, bodies } = setup(async () => {});

    await answerQuestion(client, question, { text: "because" });

    expect(bodies).toMatchObject([
      {
        id: "answer:q1",
        name: "agent/answer",
        data: {
          agent: "app/boss",
          thread: "b1",
          re: "q1",
          outcome: "answered",
          text: "because",
        },
      },
    ]);
  });

  test("a refusal and a timeout carry an outcome and no text", async () => {
    const { client, bodies } = setup(async () => {});

    await answerQuestion(client, question, { outcome: "refused" });

    expect(bodies[0]?.data).toMatchObject({ re: "q1", outcome: "refused" });
    expect(bodies[0]?.data).not.toHaveProperty("text");
  });

  test("an answer to a plain function is routed by the question's id alone", async () => {
    const { client, bodies } = setup(async () => {});

    await answerQuestion(
      client,
      {
        data: {
          id: "q2",
          text: "?",
          from: { kind: "function", id: "caller", key: "r1" },
        },
      },
      { text: "yes" },
    );

    expect(bodies[0]?.data).toMatchObject({ re: "q2", outcome: "answered" });
    expect(bodies[0]?.data).not.toHaveProperty("agent");
  });
});

describe("msg.reply()", () => {
  test("a folded question is answered with reply(), which sends the agent/answer", async () => {
    const { client, bodies } = setup(async () => {});
    const agents = createAgents(client, { store: memoryKvAdapter() });
    const callee = agents.agent({ id: "callee" }, async ({ inbox }) => {
      const message = await inbox.next();

      if (message?.name === "agent/question") {
        await message.reply("because");
      }

      return message?.name;
    });
    const { output } = await run(callee.fn, {
      event: {
        name: "agent/question",
        data: {
          agent: `${testClientId}/callee`,
          thread: "t1",
          id: "q9",
          text: "why?",
          from: { kind: "function", id: "caller", key: "r1" },
        },
      },
    });

    expect(output).toBe("agent/question");
    expect(bodies).toMatchObject([
      {
        id: "answer:q9",
        name: "agent/answer",
        data: { re: "q9", text: "because" },
      },
    ]);
  });
});
