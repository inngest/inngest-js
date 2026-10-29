/**
 * @module
 * Proves a sandbox definition's `setup`: it runs once, durably, right after
 * the sandbox is created and before the first tool call uses it (restore a
 * saved workspace, then run a command). A second sandbox with a setup that
 * the agent never uses is never created, so its setup never runs.
 */
import { Inngest } from "inngest";
import {
  agent,
  createAgents,
  createKv,
  getThread,
  redisKvAdapter,
  sandbox,
} from "inngest/experimental/agents";
import { scenario, script } from "../kit/driver.ts";
import { textOf } from "../kit/text.ts";

const agentId = "sandbox-setup-agent";
const ref = `agents-e2e/${agentId}`;

const workspace = "saved-workspace";

const bench = sandbox({
  id: "setup-bench",
  tools: sandbox.tools.code({ session: false }),
  setup: async ({ sandbox: box, step }) => {
    const saved = await step.run("load", async () => {
      return workspace;
    });

    await box.files.write("restore", { path: "/tmp/ws.txt", data: saved });
    await box.commands.run("init", "echo setup-init");
  },
});
const spare = sandbox({
  id: "setup-spare",
  tools: sandbox.tools.code(),
  setup: async ({ sandbox: box }) => {
    await box.commands.run("init", "echo spare-init");
  },
});

export const sandboxSetup = scenario({
  id: "sandbox-setup",
  owner: "agents-sandbox-setup",
  needs: { oss: "jack/step-subscribe-wake" },
  sandbox: "fake",
  functions: ({ client }) => {
    const agents = createAgents(client);

    agents.agent(
      { id: agentId, sandboxes: { work: bench, spare } },
      async ({ inbox, control, sandboxTools }) => {
        const first = await inbox.next();
        const result = await agent.loop({
          model: script([
            {
              call: { name: "work_run", input: { command: "echo tool-ran" } },
            },
            { say: "done" },
          ]),
          prompt: first ?? "",
          tools: sandboxTools,
          ...control,
        });

        return { text: result.text };
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const thread = getThread(client, ref, `setup-${Date.now()}`, {
      kv: createKv({ adapter: redisKvAdapter(ctx.redisUrl) }),
    });

    await thread.send("go");
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.exec" })
      .toHaveCount(2);
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.create" })
      .toHaveCount(1);

    const calls = ctx.fakes.posts({ channel: "sandbox" }).map((call) => {
      return `${call.method}:${JSON.stringify(call.body.command ?? call.body.text ?? "")}`;
    });

    ctx.check(
      "setup ran after create and before the tool call",
      JSON.stringify(calls) ===
        JSON.stringify([
          'sandbox.create:""',
          `sandbox.upload:"${workspace}"`,
          'sandbox.exec:["/bin/sh","-c","echo setup-init"]',
          'sandbox.exec:["/bin/sh","-c","echo tool-ran"]',
          'sandbox.pause:""',
        ]),
      calls,
    );
    ctx.check(
      "the unused sandbox's setup never ran",
      !calls.join().includes("spare-init"),
    );
  },
});
