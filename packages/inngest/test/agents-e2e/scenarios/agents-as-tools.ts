/**
 * @module
 * Agents as tools: a lead passes two agents in `tools`, one plain and one with
 * a typed `invoke()` schema, and the model calls both. The plain agent reads
 * the call as an `agent/message` with `data.text`; the typed one gets its
 * schema's data. Both results come back as the tool results, and the lead's
 * `mayCall` does not stop either.
 */
import { Inngest, invoke } from "inngest";
import {
  agent,
  createAgents,
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario, script } from "../kit/driver.ts";

const app = "agents-e2e";

export const agentsAsTools = scenario({
  id: "agents-as-tools",
  owner: "agents-as-tools",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client }) => {
    const agents = createAgents(client);

    const researcher = agents.agent(
      { id: "at-researcher", description: "Answers a question" },
      async ({ inbox }) => {
        const message = await inbox.next();

        return {
          answer: `researched: ${message?.name === "agent/message" ? message.data.text : "?"}`,
        };
      },
    );

    const coder = agents.agent(
      {
        id: "at-coder",
        description: "Writes code",
        on: invoke(z.object({ task: z.string() })),
      },
      async ({ event: started }) => {
        return { summary: `coded: ${started.data.event?.data.task}` };
      },
    );

    agents.agent(
      {
        id: "at-lead",
        limits: { mayCall: [`${app}/not-a-child`] },
      },
      async ({ inbox, control }) => {
        await inbox.next();

        const result = await agent.loop({
          model: script([
            { call: { name: "researcher", input: { message: "why" } } },
            { call: { name: "coder", input: { task: "fizz" } } },
            { say: "done" },
          ]),
          prompt: "split it",
          tools: { researcher, coder },
          ...control,
        });

        await kv.thread.set(
          "result",
          result.toolCalls.map((call) => {
            return {
              name: call.name,
              isError: call.isError,
              output: call.output,
            };
          }),
        );
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({ id: app, baseUrl: ctx.devUrl, isDev: true });
    const thread = getThread(client, `${app}/at-lead`, `at-${Date.now()}`, {
      kv: store,
    });

    await thread.send("go");

    const state = await ctx.eventually(
      "the lead has a result",
      thread.state,
      (s) => {
        return s.keys.result !== undefined;
      },
    );
    const calls = state.keys.result as {
      name: string;
      isError: boolean;
      output: unknown;
    }[];

    ctx.check(
      "the plain agent got the message as agent/message text and answered",
      calls[0]?.name === "researcher" &&
        !calls[0].isError &&
        JSON.stringify(calls[0].output) ===
          JSON.stringify({ answer: "researched: why" }),
      calls,
    );
    ctx.check(
      "the typed agent got its schema's data and answered",
      calls[1]?.name === "coder" &&
        !calls[1].isError &&
        JSON.stringify(calls[1].output) ===
          JSON.stringify({ summary: "coded: fizz" }),
      calls,
    );
  },
});
