/**
 * @module
 * Proves the model's inbox listeners survive a worker restart. The model
 * listens to an event with a `match`, the app process is killed and started
 * again, and only then do events arrive: one the `match` excludes and one it
 * admits. The model's `inbox_wait` then returns the admitted one, and
 * `inbox_read` and `inbox_stop` still know the listener, so the tools' state
 * is rebuilt from the memoized steps of the run, not kept in the process.
 */
import { Inngest } from "inngest";
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
import { scenario } from "../kit/driver.ts";
import { textOf } from "../kit/text.ts";
import { withKeys } from "../kit/threads.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const agentId = "inbox-restart-agent";
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

export const inboxToolsRestart = scenario({
  id: "inbox-tools-restart",
  owner: "agents-inbox-tools",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);
    const checks = event("check");

    agents.agent(
      {
        id: agentId,
        inboxTools: {
          listen: [{ event: checks, thread: "event.data.t" }],
          maxWait: "5m",
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
                    source: checks,
                    match: { "data.state": "green" },
                    as: "ci",
                  });
                case 2:
                  return call(2, "inbox_wait", { timeout: "5m", as: "ci" });
                case 3:
                  return call(3, "inbox_read", { all: true });
                case 4:
                  return call(4, "inbox_stop", { as: "ci" });
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
            prompt: message,
            tools: { ...tools },
            onToolResult: async (run) => {
              await kv.thread.update(kvKey<string[]>("log"), (log) => {
                return [
                  ...(log ?? []),
                  `${run.name}:${run.isError ? "error" : "ok"}:${JSON.stringify(run.output).slice(0, 400)}`,
                ];
              });
            },
            ...control,
          });

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
    const key = `inbox-restart-${Date.now()}`;
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
    await ctx.until(log, (seen) => {
      return seen.some((line) => {
        return line.startsWith("inbox_listen:ok");
      });
    });

    // The model has listened and is about to wait (or is waiting): the process
    // that holds the run goes away and a new one starts.
    await ctx.restartApp();

    await check("red");
    await sleep(1500);
    ctx.check(
      "an event the match excludes does not end the wait, after a restart",
      !(await log()).some((line) => {
        return line.startsWith("inbox_wait");
      }),
      await log(),
    );

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

    ctx.check("the model finished", finished === "done", finished);
    ctx.check(
      "inbox_wait returned the admitted event",
      final.some((line) => {
        return line.startsWith("inbox_wait:ok") && line.includes("green");
      }),
      final,
    );
    ctx.check(
      "inbox_read knew the listener and saw only the admitted event",
      final.some((line) => {
        return (
          line.startsWith("inbox_read:ok") &&
          line.includes("green") &&
          !line.includes("red")
        );
      }),
      final,
    );
    ctx.check(
      "inbox_stop knew the listener",
      final.some((line) => {
        return line.startsWith("inbox_stop:ok");
      }),
      final,
    );
  },
});
