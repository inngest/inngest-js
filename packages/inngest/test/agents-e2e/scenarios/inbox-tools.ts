/**
 * @module
 * Proves the model-facing inbox tools. The agent allows one source and one
 * listener. The model asks for a source that is not listed (a tool error that
 * names the allowed ones), listens to the allowed one, asks for a second
 * listener (refused by the cap), and goes on working with a slow tool. The
 * event arrives while that tool runs, and the loop folds it into the model's
 * next call, so the model is told without polling. The model then stops the
 * listener, and a later event is not delivered. Every step of the run is a new
 * execution of the function, so reading and stopping a listener that an earlier
 * execution started also proves that the tools' state is rebuilt on replay.
 */
import { Inngest } from "inngest";
import { tool } from "inngest/experimental";
import {
  agent,
  createAgents,
  createKv,
  getThread,
  type Kv,
  kv,
  kvKey,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const work = tool.step({
  description: "Does slow work",
  input: z.object({}),
  run: async () => {
    await sleep(5000);

    return "work done";
  },
});

const agentId = "inbox-tools-agent";
const ref = `agents-e2e/${agentId}`;

const call = (turn: number, name: string, input: Record<string, unknown>) => {
  const id = `call-${turn}-${name}`;

  return {
    message: {
      role: "assistant" as const,
      content: [{ type: "tool_use", id, name, input }],
    },
    toolCalls: [{ id, name, input }],
    usage: { input: 1, output: 1 },
  };
};

export const inboxTools = scenario({
  id: "inbox-tools",
  owner: "agents-inbox-tools",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);
    const checks = event("check");

    agents.agent(
      {
        id: agentId,
        foldMessages: "all",
        inboxTools: {
          listen: [{ event: checks, thread: "event.data.t", maxPerRun: 1 }],
          maxListeners: 1,
          maxWait: "1m",
        },
      },
      async ({ inbox, control, inboxTools: tools }) => {
        for await (const message of inbox) {
          const result = await agent.loop({
            id: `turn${message.seq}`,
            model: agent.model(async (request) => {
              switch (request.turn) {
                case 1:
                  return call(1, "inbox_listen", {
                    source: "stripe/charge",
                    as: "payments",
                  });
                case 2:
                  return call(2, "inbox_listen", { source: checks, as: "ci" });
                case 3:
                  return call(3, "inbox_listen", { source: checks, as: "ci2" });
                case 4:
                  return call(4, "work", {});
                case 5:
                  return call(5, "inbox_read", { as: "ci" });
                case 6:
                  return call(6, "inbox_stop", { as: "ci" });
                default:
                  return {
                    message: {
                      role: "assistant" as const,
                      content: [{ type: "text", text: "done" }],
                    },
                    text: "done",
                    toolCalls: [],
                    usage: { input: 1, output: 1 },
                  };
              }
            }),
            prompt: message.data.content ?? "",
            tools: { work, ...tools },
            onToolResult: async (run) => {
              await kv.thread.update(kvKey<string[]>("log"), (log) => {
                return [
                  ...(log ?? []),
                  `${run.name}:${run.isError ? "error" : "ok"}:${JSON.stringify(run.output).slice(0, 160)}`,
                ];
              });
            },
            ...control,
          });
          const steered = result.history.filter((entry) => {
            return (
              entry.role === "user" && entry.content.includes('"state":"green"')
            );
          }).length;

          await kv.thread.set("steered", steered);
          await kv.thread.set("finished", result.text);
        }
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const store: Kv = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const key = `inbox-tools-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const state = async () => {
      return thread.state();
    };
    const log = async () => {
      return ((await state()).log as string[] | undefined) ?? [];
    };
    const check = async (value: string) => {
      await client.send({
        name: ctx.event("check"),
        data: { t: key, state: value },
      });
    };

    await thread.send("go");

    // The model has listened and been refused a second listener; the slow tool
    // is running now, so the event arrives while it works.
    const lines = await ctx.until(log, (seen) => {
      return seen.some(
        (line) =>
          line.startsWith("inbox_listen:error") &&
          line.includes("Already listening"),
      );
    });

    await check("green");

    const finished = await ctx.until(
      async () => {
        return (await state()).finished as string | undefined;
      },
      (value) => {
        return value === "done";
      },
    );
    const final = await log();

    ctx.check(
      "a source that is not listed is a tool error that names the allowed ones",
      final[0]?.startsWith("inbox_listen:error") === true &&
        final[0].includes("not a source you can listen to"),
      final,
    );
    ctx.check(
      "an allowed source is listened to in the background",
      final[1]?.startsWith("inbox_listen:ok") === true &&
        final[1].includes('"listening":"ci"'),
      final,
    );
    ctx.check(
      "the cap on listeners refuses another",
      lines.some((line) => {
        return line.includes("Already listening 1 times");
      }),
      lines,
    );
    ctx.check("the model finished", finished === "done", finished);
    ctx.check(
      "the event that arrived during the slow tool was folded into the model's next call",
      (await state()).steered === 1,
      await state(),
    );
    ctx.check(
      "inbox_read still shows the event the loop folded in, since it reads through the listener's own view",
      final.some((line) => {
        return line.startsWith("inbox_read:ok") && line.includes("green");
      }),
      final,
    );
    ctx.check(
      "the model stopped the listener",
      final.some((line) => {
        return line.startsWith("inbox_stop:ok");
      }),
      final,
    );

    // The listener is gone: a later event reaches nobody.
    await check("red");
    await sleep(2500);
    ctx.check(
      "a stopped listener hears nothing more",
      (await state()).steered === 1,
      await state(),
    );
  },
});
