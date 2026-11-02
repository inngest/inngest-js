/**
 * @module
 * How a run opened through a handle ends (lead's calls L57 and L58): it ends
 * once it has answered and nothing is unread, so its `result()` resolves
 * promptly. A run a trigger started waits `idle`.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { model } from "../loop/loopKit.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { freshKv, run } from "./test-helpers.ts";

const message = (
  content: string,
  extra: { id?: string; from?: object } = {},
) => {
  return {
    ...(extra.id && { id: extra.id }),
    name: "agent/message",
    data: {
      agent: `${testClientId}/bot`,
      thread: "t1",
      content,
      ...(extra.from && { from: extra.from }),
    },
  };
};

const sender = { kind: "function", id: "caller", key: "r1", depth: 1 };

const waited = (ops: { op: string; opts: unknown }[]) => {
  return ops.filter((op) => {
    return (
      op.op === "wait" &&
      (op.opts as { timeout?: unknown }).timeout !== undefined
    );
  });
};

describe("a run opened through a handle", () => {
  const make = (read: "inbox" | "batches") => {
    freshKv();

    return createAgentFunction(
      new Inngest({ id: testClientId }),
      { id: "bot", idle: "1m" },
      async ({ inbox }) => {
        const seen: unknown[] = [];

        if (read === "batches") {
          for await (const batch of inbox.batches()) {
            for (const m of batch) {
              seen.push((m.data as { content?: unknown }).content);
            }
          }
        } else {
          for await (const m of inbox) {
            seen.push((m.data as { content?: unknown }).content);
          }
        }

        return seen;
      },
    );
  };

  test.each(["inbox", "batches"] as const)(
    "for await over the %s yields what is unread and ends without waiting idle",
    async (read) => {
      const agent = make(read);
      const { output, ops } = await run(agent.fn, {
        event: message("first", { from: sender }),
        saved: [message("second")],
      });

      expect(output).toEqual(["first", "second"]);
      expect(waited(ops)).toEqual([]);
    },
  );

  test.each(["inbox", "batches"] as const)(
    "a run a trigger started with the same handler waits idle (%s)",
    async (read) => {
      const agent = make(read);
      const { output, ops } = await run(agent.fn, {
        event: message("first"),
        saved: [message("second")],
        timeouts: 1,
      });

      expect(output).toEqual(["first", "second"]);
      expect(waited(ops).length).toBeGreaterThan(0);
    },
  );
});

describe("a model agent opened through a handle (L58)", () => {
  const make = (requests: unknown[][]) => {
    freshKv();

    return createAgentFunction(new Inngest({ id: testClientId }), {
      id: "bot",
      model: model(async (request) => {
        requests.push(
          request.messages.flatMap((m) => {
            return m.role === "user" ? [m.content] : [];
          }),
        );

        return {
          message: { role: "assistant", content: [] },
          text: `answer ${requests.length}`,
          toolCalls: [],
          usage: { input: 1, output: 1 },
        };
      }),
    });
  };

  test("the default handler does exactly one drain after the answer, and that drain is the last read", async () => {
    const requests: unknown[][] = [];
    const agent = make(requests);
    const { ops, output } = await run(agent.fn, {
      event: message("first", { from: sender }),
    });
    const drains = ops.filter((op) => {
      return (
        op.op === "wait" &&
        (op.opts as { batch?: { drain?: boolean } }).batch?.drain === true
      );
    });

    // The run's first read, the loop's read before its one model call, and
    // the single drain after the answer; nothing waits for more.
    expect(drains).toHaveLength(3);
    expect(ops.at(-1)?.op).toBe("close");
    expect(requests).toHaveLength(1);
    expect(output).toBe("answer 1");
  });

  test("with nothing sent during the call, the run ends after the answer", async () => {
    const requests: unknown[][] = [];
    const agent = make(requests);
    const { output, ops } = await run(agent.fn, {
      event: message("first", { from: sender }),
    });

    expect(requests).toHaveLength(1);
    expect(output).toBe("answer 1");
    expect(waited(ops)).toEqual([]);
  });
});
