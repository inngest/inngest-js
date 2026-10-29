/**
 * @module
 * A run cancelled while it is blocked in `next()` leaves nothing that disturbs
 * the next run of the thread: the stop frees the singleton, the next message
 * starts a fresh run, and that run reads it. A wait pause left behind by the
 * cancelled run would be consumed by the new run's first message instead.
 */
import { Inngest } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  kvKey,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

const agentId = "subscribe-cancel-agent";
const ref = `agents-e2e/${agentId}`;

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const subscribeCancel = scenario({
  id: "subscribe-cancel",
  owner: "agents-thread-key",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        on: {
          event: event("msg"),
          thread: "event.data.thread",
          message: (trigger) => {
            return trigger.data.text as string;
          },
        },
      },
      async ({ inbox }) => {
        await kv.thread.update(kvKey<number>("runs"), function (runs) {
          return (runs ?? 0) + 1;
        });

        for await (const message of inbox) {
          await kv.thread.update(kvKey<string[]>("read"), function (read) {
            return [...(read ?? []), message.content ?? ""];
          });
        }
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const key = `cancel-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const state = thread.state;

    await ctx.send("msg", { thread: key, text: "m0" });
    await ctx.until(state, (s) => {
      return (s.read as string[] | undefined)?.length === 1;
    });
    await ctx.send("msg", { thread: key, text: "m1" });
    await ctx.until(state, (s) => {
      return (s.read as string[] | undefined)?.length === 2;
    });

    // The run is blocked in next(), waiting for the third message.
    await sleep(2000);
    const stopped = await thread.stop({ when: "now" });
    ctx.check("stop now found the live run", stopped.stopped === true, stopped);
    await sleep(3000);

    // The next message starts a new run, which reads it.
    await ctx.send("msg", { thread: key, text: "after" });
    const after = await ctx.until(state, (s) => {
      return (s.read as string[] | undefined)?.includes("after") === true;
    });
    ctx.check("a new run read the message", after.runs === 2, after);
  },
});
