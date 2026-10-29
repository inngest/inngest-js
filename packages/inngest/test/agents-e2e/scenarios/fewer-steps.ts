/**
 * @module
 * The fixed steps of an agent run: an inbox with several sources opens in one
 * step, the thread record is written at the start without a step of its own
 * beside the read of the last run, and each model turn's record rides in its
 * model step.
 */
import { tool } from "inngest/experimental";
import { agent, createAgents } from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario, script } from "../kit/driver.ts";
import { textOf } from "../kit/text.ts";

const agentId = "fewer-steps-agent";

export const fewerSteps = scenario({
  id: "fewer-steps",
  owner: "agents-fewer-steps",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        on: { event: event("go"), thread: "event.data.thread" },
        inbox: [
          { event: event("a"), thread: "event.data.thread" },
          { event: event("b"), thread: "event.data.thread" },
          { event: event("c"), thread: "event.data.thread" },
        ],
      },
      async ({ inbox, control }) => {
        const first = await inbox.next();
        const note = tool.step({
          description: "Notes a number",
          input: z.object({}),
          run: async () => {
            return "noted";
          },
        });

        const result = await agent.loop({
          model: script([
            { call: { name: "note", input: {} } },
            { say: "all done" },
          ]),
          prompt: first ?? "",
          tools: { note },
          ...control,
        });

        return { text: result.text };
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const run = await ctx.finished(
      await ctx.send(
        "go",
        { thread: `thread-${Date.now()}`, content: "go" },
        { startsRun: true },
      ),
    );

    ctx.expect.run(run).toComplete();

    const named = (match: (name: string) => boolean) => {
      return run.steps.filter(match).length;
    };

    ctx.check(
      "the four sources open in one step",
      named((name) => {
        return name.startsWith("inbox:") && name.endsWith("open:all");
      }) +
        named((name) => {
          return /^inbox:\d+:open$/.test(name);
        }) ===
        1,
      run.steps,
    );
    ctx.check(
      "the start is one step and the two turns write the record in their model steps",
      named((name) => {
        return name === "Thread state";
      }) === 1 &&
        named((name) => {
          return name.startsWith("kv.update:thread:__state");
        }) === 0 &&
        named((name) => {
          return name.startsWith("kv.get:thread:__lastRun");
        }) === 0,
      run.steps,
    );
    ctx.check(`steps in this run: ${run.steps.length}`, true, run.steps);
  },
});
