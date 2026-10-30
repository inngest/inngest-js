/**
 * @module
 * Proves a shell session on a sandbox: `cd` and `export` carry to the commands
 * called after them, whether app code calls `sandbox.shell().$` or a model
 * calls the `run` tool, and every request of the run replays the earlier
 * commands from memoized results rather than running them again.
 */
import type { DurableSandbox } from "inngest/experimental";
import { agent } from "inngest/experimental/agents";
import { scenario, script } from "../kit/driver.ts";

export const shellSession = scenario({
  id: "shell-session",
  owner: "agents-shell-session",
  sandbox: "fake",
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "shell-session-fn", triggers: [{ event: event("go") }] },
        async ({ group }) => {
          return group.sandbox("box", async (sandbox: DurableSandbox) => {
            const sh = sandbox.shell({ cwd: "/work" });

            await sh.$.sh`mkdir -p app/pkg`;
            await sh.$`cd app`;
            await sh.$.sh`export STAGE=test`;

            const [here, stage] = await Promise.all([
              sh.$.sh`pwd`.text(),
              sh.$.sh`echo "$STAGE"`.text(),
            ]);

            const result = await agent.loop({
              model: script([
                { call: { name: "run", input: { command: "cd pkg" } } },
                { call: { name: "run", input: { command: "pwd" } } },
                { say: "done" },
              ]),
              prompt: "go to pkg",
              tools: sandbox.tools.code({ only: ["run"], cwd: "/work/app" }),
            });

            return { here, stage, cwd: sh.cwd, text: result.text };
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
      here: "/work/app",
      stage: "test",
      cwd: "/work/app",
      text: "done",
    });
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.exec" })
      .toHaveCount(7);
  },
});
