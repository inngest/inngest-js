/**
 * @module
 * Tests that `kv.thread` inside a tool the loop runs is the run's own thread,
 * whether the tool step runs in the request that found it or in one of its
 * own, and for a run whose trigger is not an agent message.
 */
import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import { tool } from "../../../components/sandbox/tools.ts";
import { testClientId } from "../../../test/helpers.ts";
import { currentThreadKey, kv } from "../kv/kv.ts";
import type { AgentModelResponse } from "../loop/loop.ts";
import { model } from "../loop/loopKit.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { freshKv, run } from "./test-helpers.ts";

beforeEach(() => {
  freshKv();
});

const calls = (...ids: string[]): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [] },
    toolCalls: ids.map((id) => {
      return { id, name: "remember", input: { id } };
    }),
  };
};

const done: AgentModelResponse = {
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  text: "done",
  toolCalls: [],
};

test("kv.thread in a tool step is the run's thread, in its own request and in the one that found it", async () => {
  const seen: { id: string; thread: string | undefined; read: unknown }[] = [];

  const remember = tool.step({
    input: z.object({ id: z.string() }),
    run: async ({ id }) => {
      await kv.thread.set(`tool:${id}`, id);

      seen.push({
        id,
        thread: currentThreadKey(),
        read: await kv.thread.get(`tool:${id}`),
      });

      return id;
    },
  });

  // Two calls in one turn are planned and each runs in a request of its own;
  // the single call of the second turn runs in the request that found it.
  const replies = [calls("a", "b"), calls("c"), done];
  let turn = 0;

  const { fn } = createAgentFunction(
    new Inngest({ id: testClientId }),
    {
      id: "bot",
      triggers: { event: "shop/order", thread: "event.data.id" },
      tools: { remember },
      model: model(async () => {
        return replies[Math.min(turn++, replies.length - 1)] ?? done;
      }),
    } as never,
    async ({ loop }) => {
      await loop("go");

      return {
        a: await kv.thread.get("tool:a"),
        b: await kv.thread.get("tool:b"),
        c: await kv.thread.get("tool:c"),
        other: await kv.scope("thread", "o2").get("tool:a"),
      };
    },
  );

  const { output, error } = await run(fn, {
    event: { name: "shop/order", data: { id: "o1" } },
  });

  expect(error).toBeUndefined();
  expect(output).toEqual({ a: "a", b: "b", c: "c", other: undefined });

  const byId = Object.fromEntries(
    seen.map((entry) => {
      return [entry.id, entry];
    }),
  );

  for (const id of ["a", "b", "c"]) {
    expect(byId[id]).toEqual({ id, thread: "o1", read: id });
  }
});
