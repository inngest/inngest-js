/**
 * @module
 * A handle-opened model agent that started a child with `start_agent` and has
 * nothing else to do keeps its run open (lead's calls L70 and L74): the
 * child's `agent/finished` is shown to the model and the answer after it is
 * the parent's output. A child that never finishes is waited for only up to
 * the bound, then the model gets one last turn that names it.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { model } from "../loop/loopKit.ts";
import { createAgents } from "./agents.ts";
import { childWait } from "./children.ts";
import { run } from "./test-helpers.ts";

const sender = { kind: "function", id: "caller", key: "r1", depth: 1 };

const functionList = [
  { slug: `${testClientId}-child`, is_paused: false, is_archived: false },
];

const make = () => {
  const client = new Inngest({
    id: testClientId,
    fetch: (async () => {
      return new Response(JSON.stringify(functionList), { status: 200 });
    }) as never,
  });
  const agents = createAgents(client, { store: memoryKvAdapter() });
  const requests: string[][] = [];

  agents.agent({ id: "child" });

  const parent = agents.agent({
    id: "bot",
    model: model(async (request) => {
      requests.push(
        request.messages.flatMap((m) => {
          return m.role === "user" ? [JSON.stringify(m.content)] : [];
        }),
      );

      const startedAlready = request.messages.some((m) => {
        return m.role === "tool";
      });
      const last = requests.at(-1)?.at(-1) ?? "";

      if (requests.length === 1) {
        return {
          message: { role: "assistant", content: [] },
          text: "",
          toolCalls: [
            {
              id: "c1",
              name: "start_agent",
              input: { address: `${testClientId}/child`, input: "work" },
            },
          ],
          usage: { input: 1, output: 1 },
        };
      }

      return {
        message: { role: "assistant", content: [] },
        text:
          startedAlready && !/finished|still running/.test(last)
            ? "started"
            : `saw: ${last}`,
        toolCalls: [],
        usage: { input: 1, output: 1 },
      };
    }),
  });

  // The start message goes out through the client; nothing here listens.
  Object.defineProperty(client, "_send", {
    configurable: true,
    value: async () => {
      return { ids: [], status: 200 };
    },
  });
  vi.spyOn(client, "queryInsights").mockRejectedValue(
    new Error("Insights query failed: 501 Not Implemented - no"),
  );
  vi.spyOn(client, "listEvents").mockResolvedValue([]);

  return { parent, requests };
};

const start = {
  name: "agent/message",
  data: {
    agent: `${testClientId}/bot`,
    thread: "t1",
    content: "go",
    from: sender,
  },
};

const childKey = `${testClientId}/child:run-parent.0`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a handle-opened model agent that started a child", () => {
  test("stays open after its answer while the child runs: the run waits for the child's agent/finished", async () => {
    const { parent, requests } = make();
    const { output, waiting, ops } = await run(parent.fn, {
      event: start,
      runId: "run-parent",
    } as never);

    // The model answered ("started") and the run did not end: it is blocked
    // on a sleep beside the read that waits up to the bound for the child.
    expect(requests).toHaveLength(2);
    expect(waiting).toBe(true);
    expect(output).toBeUndefined();
    expect(
      ops.some((op) => {
        return (
          op.op === "wait" &&
          (op.opts as { timeout?: unknown }).timeout !== undefined
        );
      }),
    ).toBe(true);
  });

  test("a child that never finishes is waited for up to the bound, then the model names it", async () => {
    const before = childWait.ms;

    childWait.ms = 5000;

    try {
      const { parent, requests } = make();
      const { output } = await run(parent.fn, {
        event: start,
        runId: "run-parent",
        timeouts: 1,
      } as never);
      const finalTurn = requests.at(-1)?.at(-1) ?? "";

      expect(finalTurn).toContain("still running");
      expect(finalTurn).toContain(childKey);
      expect(output).toMatch(/^saw: /);
    } finally {
      childWait.ms = before;
    }
  });
});
