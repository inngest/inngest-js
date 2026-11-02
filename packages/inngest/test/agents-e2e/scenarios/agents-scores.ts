/**
 * @module
 * Scores: an agent scores its own model and tool steps with no extra
 * steps, a tool adds its own with `scores.score()`, and an
 * agent with `scores: false` writes none of the framework's. The scores are
 * read back from the Dev Server's trace.
 */
import { tool } from "inngest/experimental";
import { agent, createAgents } from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario, script } from "../kit/driver.ts";
import { textOf } from "../kit/text.ts";

const scored = "agents-scores-on";
const silent = "agents-scores-off";

export const agentsScores = scenario({
  id: "agents-scores",
  owner: "agents-scores",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    for (const [id, scores] of [
      [scored, true],
      [silent, false],
    ] as const) {
      agents.agent(
        {
          id,
          scores,
          on: { event: event(id), thread: "event.data.thread" },
        },
        async ({ inbox, control, scores: own }) => {
          const first = await inbox.next();
          const note = tool.step({
            description: "Notes a number",
            input: z.object({}),
            run: async () => {
              await own.score("support.noted", 7);

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
    }

    return agents.functions();
  },
  run: async (ctx) => {
    for (const id of [scored, silent]) {
      const run = await ctx.finished(
        await ctx.send(
          id,
          { thread: `thread-${id}`, content: "go" },
          { startsRun: true },
        ),
      );

      ctx.expect.run(run).toComplete();

      const scores = await ctx.scores(run.id);
      const model = scores.step("agent:model:1");
      const tool = scores.step("agent:1.0:note");
      const framework = [model, tool].flatMap((own) => {
        return Object.keys(own).filter((name) => {
          return name.startsWith("agent.");
        });
      });

      ctx.check(
        `${id}: the tool's own score is written either way`,
        tool["support.noted"] === 7,
        tool,
      );

      if (id === silent) {
        ctx.check(
          `${id}: the framework writes no scores`,
          framework.length === 0,
          framework,
        );

        continue;
      }

      ctx.check(
        `${id}: the first model step has its time, tokens and tool calls`,
        typeof model["agent.model_ms"] === "number" &&
          model["agent.tool_calls"] === 1 &&
          model["agent.steers"] === 0 &&
          model["agent.input_tokens"] === 10 &&
          model["agent.output_tokens"] === 5,
        model,
      );

      ctx.check(
        `${id}: the tool step has its time and no error`,
        typeof tool["agent.tool_ms"] === "number" &&
          tool["agent.tool_error"] === 0,
        tool,
      );
    }
  },
});
