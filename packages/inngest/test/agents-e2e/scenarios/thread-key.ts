/**
 * @module
 * A thread key from the trigger: two trigger events for the same thread start
 * one run and the second is delivered to it; another thread starts its own
 * run; the key is stamped on the messages as sessions.
 */
import { Inngest } from "inngest";
import {
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";

const agentId = "thread-key-agent";
const ref = `agents-e2e/${agentId}`;

const list = (state: Record<string, unknown>, key: string) => {
  return (state[key] as string[] | undefined) ?? [];
};

export const threadKey = scenario({
  id: "thread-key",
  owner: "agents-thread-key",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client, event }) => {
    const bot = client.agent(
      {
        id: agentId,
        on: {
          event: event("msg"),
          thread: ({ event: trigger }) => {
            return `${trigger.data.channel}/${trigger.data.thread_ts ?? trigger.data.ts}`;
          },
          message: ({ event: trigger }) => {
            return trigger.data.text as string;
          },
        },
      },
      async ({ inbox }) => {
        await kv.thread.update<number>("runs", function (runs) {
          return (runs ?? 0) + 1;
        });

        for await (const message of inbox) {
          await kv.thread.update<string[]>("turns", function (turns) {
            return [...(turns ?? []), message.data.content ?? ""];
          });
        }
      },
    );

    return bot.functions;
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const stamp = Date.now();
    const channel = `C${stamp}`;
    const handle = (key: string) => {
      return getThread(client, ref, key, { kv: store });
    };
    const t1 = handle(`${channel}/1.0`);
    const t2 = handle(`${channel}/2.0`);

    await ctx.send("msg", { channel, thread_ts: "1.0", text: "first" });
    await ctx.eventually("first message starts the thread", t1.state, (s) => {
      return list(s, "turns").includes("first");
    });
    await ctx.send("msg", {
      channel,
      ts: "9.9",
      thread_ts: "1.0",
      text: "second",
    });
    const state = await ctx.eventually(
      "second message is delivered to the live run",
      t1.state,
      (s) => {
        return list(s, "turns").includes("second");
      },
    );

    ctx.check("one run for the thread", state.runs === 1, state);
    ctx.check(
      "each message is one turn, in order",
      JSON.stringify(list(state, "turns")) ===
        JSON.stringify(["first", "second"]),
      state,
    );

    await ctx.send("msg", { channel, ts: "2.0", text: "other" });
    const other = await ctx.eventually(
      "another thread starts its own run",
      t2.state,
      (s) => {
        return list(s, "turns").includes("other");
      },
    );

    ctx.check("the other thread has its own run", other.runs === 1, other);
  },
});
