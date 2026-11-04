/**
 * @module
 * How a run opened through a handle ends (lead's calls L57 and L58): it ends
 * once it has answered and nothing is unread, so its `result()` resolves
 * promptly. A run a trigger started waits `idle`.
 */

import { z } from "zod";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { Inngest } from "../../../components/Inngest.ts";
import { invoke } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { model } from "../loop/loopKit.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { childWait, trackChild } from "./children.ts";
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
  const make = (read: "inbox" | "batches", idle?: string) => {
    freshKv();

    return createAgentFunction(
      new Inngest({ id: testClientId }),
      { id: "bot", ...(idle && { idle }) },
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
    "an explicit idle keeps a handle-opened run waiting (%s)",
    async (read) => {
      const agent = make(read, "1m");
      const { output, ops } = await run(agent.fn, {
        event: message("first", { from: sender }),
        saved: [message("second")],
        timeouts: 1,
      });

      expect(output).toEqual(["first", "second"]);
      expect(waited(ops).length).toBeGreaterThan(0);
    },
  );

  test.each(["inbox", "batches"] as const)(
    "a run a trigger started with the same handler waits idle (%s)",
    async (read) => {
      const agent = make(read, "1m");
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

  test("the default handler never drains: one read waits beside the call, and nothing reads after the answer", async () => {
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

    // No read is a drain: the loop's fold takes from the queue, and the one
    // read the run makes waits beside the model call.
    expect(drains).toHaveLength(0);
    expect(
      ops.filter((op) => {
        return op.op === "wait";
      }),
    ).toHaveLength(1);
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

describe("a run opened through a handle waits for the runs it started with start_agent (L70, L74)", () => {
  const finishedFrom = (key: string) => {
    return {
      name: "agent/finished",
      data: {
        agent: `${testClientId}/bot`,
        thread: "t1",
        from: { kind: "agent", address: "team/child", key },
        outcome: "completed",
        output: "child done",
      },
    };
  };

  const make = (track: string[]) => {
    freshKv();

    return createAgentFunction(
      new Inngest({ id: testClientId }),
      { id: "bot" },
      async ({ inbox }) => {
        const instance = getAsyncCtxSync()?.execution?.instance as object;

        for (const key of track) {
          trackChild(instance, key);
        }

        const seen: unknown[] = [];

        for await (const m of inbox) {
          seen.push(m.name);
        }

        return seen;
      },
    );
  };

  test("the child's agent/finished folds in and the run ends after the last one", async () => {
    const agent = make(["c1"]);
    const { output, ops } = await run(agent.fn, {
      event: message("first", { from: sender }),
      incoming: [finishedFrom("c1")],
    });

    expect(output).toEqual(["agent/message", "agent/finished"]);
    expect(waited(ops)).toHaveLength(1);
  });

  test("a child started with start() holds nothing: the run ends at once", async () => {
    const agent = make([]);
    const { output, ops } = await run(agent.fn, {
      event: message("first", { from: sender }),
    });

    expect(output).toEqual(["agent/message"]);
    expect(waited(ops)).toEqual([]);
  });

  test("a child that never finishes is waited for only up to the bound", async () => {
    const before = childWait.ms;

    childWait.ms = 5000;

    try {
      const agent = make(["c1"]);
      const { output, ops } = await run(agent.fn, {
        event: message("first", { from: sender }),
        timeouts: 1,
      });

      expect(output).toEqual(["agent/message"]);
      expect(
        waited(ops).map((op) => {
          return (op.opts as { timeout: unknown }).timeout;
        }),
      ).toEqual(["5s"]);
    } finally {
      childWait.ms = before;
    }
  });
});

describe("a typed agent opened through start()", () => {
  test("ends once it has answered, not when `idle` runs out", async () => {
    freshKv();

    const requests: unknown[] = [];
    const agent = createAgentFunction(new Inngest({ id: testClientId }), {
      id: "bot",
      triggers: invoke(z.object({ q: z.string() })),
      model: model(async (request) => {
        requests.push(request.messages.length);

        return {
          message: { role: "assistant", content: [] },
          text: "answered",
          toolCalls: [],
          usage: { input: 1, output: 1 },
        };
      }),
    });
    const { output, waiting, ops } = await run(agent.fn, {
      event: {
        name: "agent/message",
        data: {
          agent: `${testClientId}/bot`,
          thread: "t1",
          content: { q: "why" },
          from: { ...sender, typed: true },
        },
      },
    });

    expect(waiting).toBe(false);
    expect(output).toBe("answered");
    expect(requests).toHaveLength(1);
    expect(waited(ops)).toEqual([]);
  });
});
