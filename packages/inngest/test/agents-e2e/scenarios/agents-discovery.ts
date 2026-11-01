/**
 * @module
 * Agent discovery across two apps on one Dev Server. The lead lives in the kit
 * app; the docs agent and the notes agent live in another app. Neither app's
 * code names the other: the lead's model lists the agents, describes one,
 * calls it with the input its card asks for, and messages another, all through
 * the four discovery tools. The model here is a small script that reads each
 * tool result before it chooses the next call, as a real model would.
 */
import { Inngest, invoke } from "inngest";
import {
  agent,
  createAgents,
  createKv,
  discoveryTools,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario } from "../kit/driver.ts";

const lead = "agents-e2e/disc-lead";

const textOf = (content: unknown): string => {
  return typeof content === "string" ? content : JSON.stringify(content);
};

// Picks the agent of a list_agents result whose entry mentions `word`.
const idWith = (
  result: { content: string } | undefined,
  word: string,
): string | undefined => {
  const listed = (
    JSON.parse(result?.content ?? "{}") as { agents?: { id: string }[] }
  ).agents;

  return listed?.find((entry) => {
    return JSON.stringify(entry).toLowerCase().includes(word);
  })?.id;
};

export const agentsDiscovery = scenario({
  id: "agents-discovery",
  owner: "agent-discovery-build",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client }) => {
    const agents = createAgents(client);

    agents.agent({ id: "disc-lead" }, async ({ inbox, control }) => {
      await inbox.next();

      const background: Promise<unknown>[] = [];
      const model = agent.model(async (request) => {
        const results = request.messages.flatMap((message) => {
          return message.role === "tool" ? message.results : [];
        });
        const listed = results[0];
        const seen = results[0];
        const call = (name: string, input: unknown) => {
          const use = { id: `call-${request.turn}`, name, input };

          return {
            message: {
              role: "assistant" as const,
              content: [{ type: "tool_use", ...use }],
            },
            toolCalls: [use],
            usage: { input: 10, output: 5 },
          };
        };

        if (request.turn === 1) {
          return call("list_agents", {});
        }

        if (request.turn === 2) {
          return call("describe_agent", {
            id: idWith(seen, "documentation") ?? "none",
          });
        }

        if (request.turn === 3) {
          return call("call_agent", {
            id: idWith(seen, "documentation") ?? "none",
            input: { question: "how do I add a cron" },
          });
        }

        if (request.turn === 4) {
          return call("message_agent", {
            id: idWith(listed, "notes") ?? "none",
            thread: "disc-thread",
            text: "remember the cron answer",
          });
        }

        if (request.turn === 5) {
          return call("call_agent", {
            id: idWith(listed, "documentation") ?? "none",
            input: { question: "and a webhook" },
            background: true,
          });
        }

        return {
          message: {
            role: "assistant" as const,
            content: [{ type: "text", text: "done" }],
          },
          text: "done",
          toolCalls: [],
          usage: { input: 10, output: 5 },
        };
      });
      const result = await agent.loop({
        model,
        prompt: "find out how to add a cron and tell the notes agent",
        tools: discoveryTools({
          onBackground: ({ result }) => {
            background.push(result);
          },
        }),
        ...control,
      });
      const settled = await Promise.all(background);

      await kv.thread.set("background", settled);
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
    });

    return agents.functions();
  },
  apps: () => {
    const other = new Inngest({ id: "agents-e2e-docs" });
    const agents = createAgents(other);

    agents.agent(
      {
        id: "disc-docs",
        description: "Answers documentation questions",
        share: "team",
        effects: "read",
        skills: [
          {
            id: "docs-qa",
            description: "Finds how to do something in the documentation",
            examples: ["how do I add a cron"],
          },
        ],
        on: invoke(z.object({ question: z.string() })),
      },
      async ({ event }) => {
        return { answer: `docs say: ${event.data.event?.data.question}` };
      },
    );

    agents.agent(
      {
        id: "disc-notes",
        description: "Keeps notes of what it is told",
        share: "team",
      },
      async ({ inbox }) => {
        const message = await inbox.next();

        await kv.thread.set(
          "note",
          message?.name === "agent/message" ? message.data.text : "?",
        );
      },
    );

    return [{ client: other, functions: agents.functions() }];
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });

    // Both apps announce their cards.
    await client.send({ name: "agents/announce", data: {} });
    await ctx.eventually(
      "the docs app's cards are in the events API",
      async () => {
        const res = await fetch(
          `${ctx.devUrl}/v1/events?name=agents/registered&limit=50`,
        );

        return JSON.stringify(await res.json());
      },
      (body) => {
        return body.includes("agents-e2e-docs");
      },
    );

    const thread = getThread(client, lead, `disc-${Date.now()}`, { kv: store });

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
      "the lead listed the agents and saw the docs agent of the other app",
      calls[0]?.name === "list_agents" &&
        !calls[0].isError &&
        JSON.stringify(calls[0].output).includes("agents-e2e-docs/disc-docs"),
      calls[0],
    );
    ctx.check(
      "it described the docs agent and got its typed input",
      calls[1]?.name === "describe_agent" &&
        !calls[1].isError &&
        JSON.stringify(calls[1].output).includes("question"),
      calls[1],
    );
    ctx.check(
      "it called the docs agent across apps and got its answer",
      calls[2]?.name === "call_agent" &&
        !calls[2].isError &&
        JSON.stringify(calls[2].output) ===
          JSON.stringify({ answer: "docs say: how do I add a cron" }),
      calls[2],
    );
    ctx.check(
      "it messaged the notes agent",
      calls[3]?.name === "message_agent" && !calls[3].isError,
      calls[3],
    );

    ctx.check(
      "a background call answered at once and the result came later",
      calls[4]?.name === "call_agent" &&
        JSON.stringify(calls[4].output).includes("started") &&
        JSON.stringify(state.keys.background) ===
          JSON.stringify([{ answer: "docs say: and a webhook" }]),
      { call: calls[4], background: state.keys.background },
    );

    const notes = getThread(
      new Inngest({ id: "agents-e2e-docs", baseUrl: ctx.devUrl, isDev: true }),
      "agents-e2e-docs/disc-notes",
      "disc-thread",
      { kv: store },
    );

    await ctx.eventually(
      "the notes agent got the message",
      notes.state,
      (s) => {
        return s.keys.note === "remember the cron answer";
      },
    );
  },
});
