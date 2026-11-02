/**
 * @module
 * How a run opened through a handle ends (lead's calls L57 and L58): it ends
 * once it has answered and nothing is unread, so its `result()` resolves
 * promptly. A run a trigger started waits `idle`.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
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
      op.op === "wait" && (op.opts as { timeout?: unknown }).timeout !== undefined
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
