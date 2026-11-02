/**
 * @module
 * `agent.start()`: the code side of calling an agent. A call opens a thread
 * with a generated key, sends the input with a sender that carries the chain
 * depth, and returns a handle whose `result()` is the callee's output.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { createAgents } from "./agents.ts";
import { run } from "./test-helpers.ts";

const makeAgents = () => {
  return createAgents(new Inngest({ id: testClientId }), {
    store: memoryKvAdapter(),
  });
};

describe("agent.start()", () => {
  test("a plain agent gets an agent/message with the content and a sender", async () => {
    const agents = makeAgents();
    const callee = agents.agent({ id: "callee" });
    const caller = agents.agent({ id: "caller" }, async () => {
      const started = await callee.start("do it");

      return started.key;
    });
    const sent: unknown[] = [];
    const { output } = await run(caller.fn, {
      event: {
        name: "agent/message",
        data: { agent: `${testClientId}/caller`, thread: "c1", content: "go" },
      },
      onInvoke: (op) => {
        sent.push(op.opts);

        return { data: "done" };
      },
    });

    expect(typeof output).toBe("string");
    expect(sent).toMatchObject([
      {
        payload: {
          data: {
            agent: `${testClientId}/callee`,
            thread: output,
            content: "do it",
            from: {
              kind: "agent",
              address: `${testClientId}/caller`,
              key: "c1",
              depth: 1,
              thread: output,
            },
          },
        },
      },
    ]);
  });
});
