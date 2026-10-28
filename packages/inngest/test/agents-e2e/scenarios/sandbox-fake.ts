/**
 * @module
 * Proves the fake Sandboxes API: `group.sandbox()` creates a sandbox, runs a
 * canned command and a model-driven code tool in it, and destroys it.
 */
import type { DurableSandbox } from "inngest/experimental";
import { agent } from "inngest/experimental/agents";
import { scenario, script } from "../kit/driver.ts";

export const sandboxFake = scenario({
  id: "sandbox-fake",
  sandbox: "fake",
  sandboxCommands: { "git status": { stdout: "clean\n" } },
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "sandbox-fake-fn", triggers: [{ event: event("go") }] },
        async ({ group }) => {
          return group.sandbox("box", async (sandbox: DurableSandbox) => {
            const status = await sandbox.commands.run("status", "git status");
            const result = await agent.loop({
              model: script([
                { call: { name: "run", input: { command: "git status" } } },
                { say: "done" },
              ]),
              prompt: "check the repo",
              tools: sandbox.tools.code({ only: ["run"] }),
            });

            return { status: status.stdout.trim(), text: result.text };
          });
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(await ctx.send("go"));

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toOutput({ status: "clean", text: "done" });
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.create" })
      .toHaveCount(1);
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.exec" })
      .toHaveCount(2);
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.destroy" })
      .toHaveCount(1);
  },
});
