/**
 * @module
 * Proves sandbox start policies on an agent function: an agent declares one
 * eager and one lazy sandbox in its config, gets lazy handles and namespaced
 * tools in its body, and needs no `openSandboxes()`. The eager sandbox is
 * created when the run begins, before any tool call; the lazy one is created
 * only by the tool call that uses it.
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

const agentId = "sandbox-start-agent";
const ref = `agents-e2e/${agentId}`;

const eagerBox = sandbox({ id: "eager-box", tools: sandbox.tools.code() });
const lazyBox = sandbox({ id: "lazy-box", tools: sandbox.tools.code() });

export const sandboxStart = scenario({
  id: "sandbox-start",
  owner: "agents-sandbox-start",
  needs: { oss: "jack/step-subscribe-wake" },
  sandbox: "fake",
  sandboxCommands: { "echo sandbox-start": { stdout: "hello\n" } },
  functions: ({ client }) => {
    const agents = createAgents(client);
    const bot = agents.agent(
      {
        id: agentId,
        sandboxes: {
          fast: { sandbox: eagerBox, start: "eager" },
          slow: lazyBox,
          never: { sandbox: lazyBox, start: () => "lazy" },
        },
      },
      async ({ inbox, control, sandboxes, sandboxTools }) => {
        const first = await inbox.next();
        const result = await agent.loop({
          model: script([
            {
              call: {
                name: "slow_run",
                input: { command: "echo sandbox-start" },
              },
            },
            { say: "done" },
          ]),
          prompt: first ?? "",
          tools: sandboxTools,
          ...control,
        });

        return {
          text: result.text,
          started: Object.fromEntries(
            Object.entries(sandboxes).map(([name, handle]) => {
              return [name, handle.started];
            }),
          ),
          tools: Object.keys(sandboxTools).sort(),
        };
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
    const thread = getThread(client, ref, `start-${Date.now()}`, {
      kv: createKv({ adapter: redisKvAdapter(ctx.redisUrl) }),
    });

    await thread.send("go");
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.exec" })
      .toHaveCount(1);
    // The eager sandbox nothing used is destroyed; the one the tool used is
    // paused for the thread's next run.
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.destroy" })
      .toHaveCount(1);
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.pause" })
      .toHaveCount(1);
    await ctx.expect
      .posts({ channel: "sandbox", method: "sandbox.create" })
      .toHaveCount(2);
  },
});
