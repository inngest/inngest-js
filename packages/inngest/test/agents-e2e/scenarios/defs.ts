/**
 * @module
 * Proves tool and sandbox definitions: an agent-shaped function references a
 * `tool()` and two `sandbox()` definitions. The sandbox the model uses is
 * created lazily by its first tool call, once; the one it never touches is
 * never created.
 */
import {
  agent,
  agentTools,
  openSandboxes,
  sandbox,
  sandboxTools,
  tool,
} from "inngest/experimental";
import { z } from "zod/v4";
import { scenario, script } from "../kit/driver.ts";

const getOrg = tool({
  id: "getOrg",
  input: z.object({ slug: z.string() }),
  run: async ({ slug }) => {
    return { slug, plan: "pro" };
  },
});

const workbench = sandbox({ id: "workbench", tools: sandbox.tools.code() });
const spare = sandbox({ id: "spare", tools: sandbox.tools.code() });

export const defs = scenario({
  id: "defs",
  owner: "agents-defs",
  sandbox: "fake",
  sandboxCommands: { "git status": { stdout: "clean\n" } },
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "defs-fn", triggers: [{ event: event("go") }] },
        async ({ step }) => {
          const sandboxes = openSandboxes(
            { work: workbench, spare },
            step.sandbox,
          );

          try {
            const result = await agent.loop({
              model: script([
                { call: { name: "getOrg", input: { slug: "acme" } } },
                {
                  call: { name: "work_run", input: { command: "git status" } },
                },
                { say: "done" },
              ]),
              prompt: "check",
              tools: {
                ...agentTools([getOrg]),
                ...sandboxTools(sandboxes),
              },
            });

            return {
              text: result.text,
              workStarted: sandboxes.work?.started,
              spareStarted: sandboxes.spare?.started,
            };
          } finally {
            await Promise.all(
              Object.values(sandboxes).map((opened) => {
                return opened.close();
              }),
            );
          }
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(await ctx.send("go"));

    ctx.expect.run(run).toComplete();
    ctx.expect
      .run(run)
      .toOutput({ text: "done", workStarted: true, spareStarted: false });
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.create" })
      .toHaveCount(1);
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.exec" })
      .toHaveCount(1);
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.destroy" })
      .toHaveCount(1);
  },
});
