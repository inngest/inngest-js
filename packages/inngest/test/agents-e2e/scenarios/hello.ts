/**
 * @module
 * The smallest scenario: `agent.loop()` with a scripted model and one step
 * tool, from event to finished run.
 */

import { tool } from "inngest/experimental";
import { agent } from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario, script } from "../kit/driver.ts";

const add = tool.step({
  description: "Adds two numbers",
  input: z.object({ a: z.number(), b: z.number() }),
  run: ({ a, b }) => {
    return a + b;
  },
});

export const hello = scenario({
  id: "hello",
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "hello-agent", triggers: [{ event: event("go") }] },
        async () => {
          const result = await agent.loop({
            model: script([
              { call: { name: "add", input: { a: 1, b: 2 } } },
              { say: "It is 3" },
            ]),
            prompt: "What is 1 + 2?",
            tools: { add },
          });

          return { text: result.text };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(await ctx.send("go"));

    ctx.expect.run(run).toComplete();
    ctx.expect
      .run(run)
      .toHaveSteps("agent:model:1", "agent:1.0:add", "agent:model:2");
    ctx.expect.run(run).toOutput({ text: "It is 3" });
  },
});
