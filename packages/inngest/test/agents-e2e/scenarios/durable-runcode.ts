/**
 * @module
 * Proves `run_code` in `sandbox.tools.code()`: a TypeScript snippet calls an
 * app tool, then sleeps twice through `tools.sleep`. Each sleep ends the
 * process and the run waits with no command running; the snippet then starts
 * again from the top with its earlier calls answered from the journal, so the
 * `add` tool runs once however many times the snippet does. The fake sandbox
 * runs the call-home wrapper and stubs for real.
 */
import { type DurableSandbox, tool } from "inngest/experimental";
import { agent } from "inngest/experimental/agents";
import { z } from "zod";
import { scenario, script } from "../kit/driver.ts";

const code = `
const sum = await tools.add({ a: 1, b: 2 });
console.log("sum", sum);
await tools.sleep({ duration: "1s" });
const first = await tools.now();
await tools.sleep({ duration: "1s" });
console.log("done", sum, typeof first);
return { sum };
`;

export const durableRuncode = scenario({
  id: "durable-runcode",
  sandbox: "fake",
  functions: ({ client, event }) => {
    let adds = 0;

    return [
      client.createFunction(
        { id: "durable-runcode-fn", triggers: [{ event: event("go") }] },
        async ({ group }) => {
          return group.sandbox("box", async (sandbox: DurableSandbox) => {
            const add = tool.step({
              input: z.object({ a: z.number(), b: z.number() }),
              run: ({ a, b }) => {
                adds += 1;

                return a + b;
              },
            });
            const result = await agent.loop({
              model: script([
                {
                  call: {
                    name: "run_code",
                    input: { language: "typescript", code },
                  },
                },
                { say: "finished" },
              ]),
              prompt: "add, wait, finish",
              tools: sandbox.tools.code({
                cwd: "/tmp",
                only: ["run_code"],
                tools: { add },
              }),
            });

            return {
              text: result.text,
              adds,
              output: result.toolCalls[0]?.output,
            };
          });
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(
      await ctx.send("go", {}, { startsRun: true }),
    );

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toOutput({
      text: "finished",
      adds: 1,
      output: 'exit 0\nsum 3\ndone 3 string\n\nreturned:\n{"sum":3}',
    });
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.process" })
      .toHaveCount(3);
  },
});
