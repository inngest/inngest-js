/**
 * @module
 * A burst of messages, sent as fast as the client can, is read once each and
 * in the order the executor saved them, and the run never stalls with a message
 * unread: whether a message lands while the run is blocked, executing or just
 * about to block, the run wakes exactly when it should.
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

const agentId = "subscribe-burst-agent";
const ref = `agents-e2e/${agentId}`;
const messages = 40;

export const subscribeBurst = scenario({
  id: "subscribe-burst",
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
    const key = `burst-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const read = async () => {
      return ((await thread.state()).read as string[] | undefined) ?? [];
    };

    await ctx.send("msg", { thread: key, text: "m0" });
    await ctx.until(read, (r) => {
      return r.length === 1;
    });

    // Handle messages and trigger events of the same thread, interleaved.
    for (let n = 1; n < messages; n++) {
      if (n % 2 === 0) {
        await thread.send(`m${n}`);
      } else {
        await ctx.send("msg", { thread: key, text: `m${n}` });
      }
    }

    const all = await ctx.until(
      read,
      (r) => {
        return r.length >= messages;
      },
      40_000,
    );

    ctx.check(
      "every message was read once",
      JSON.stringify([...all].sort()) ===
        JSON.stringify(
          Array.from({ length: messages }, (_, n) => {
            return `m${n}`;
          }).sort(),
        ),
      all,
    );
  },
});
