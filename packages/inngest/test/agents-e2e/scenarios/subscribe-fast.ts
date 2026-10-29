/**
 * @module
 * A reader with no step between its reads wakes for every message. Each read
 * blocks, is woken, and the next wait is written straight away, while the
 * executor may still be cleaning up the wait it just consumed. A wait that is
 * lost then leaves the run blocked for good with messages unread.
 */
import { Inngest } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";
import { textOf } from "../kit/text.ts";
import { withKeys } from "../kit/threads.ts";

const agentId = "subscribe-fast-agent";
const ref = `agents-e2e/${agentId}`;
const messages = 150;

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const subscribeFast = scenario({
  id: "subscribe-fast",
  owner: "agents-thread-key",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        on: {
          event: event("msg"),
          thread: "event.data.thread",
        },
      },
      async ({ inbox }) => {
        const seen: string[] = [];

        for await (const message of inbox) {
          seen.push(textOf(message) ?? "");

          if (seen.length === messages) {
            break;
          }
        }

        await kv.thread.set("seen", seen);
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
    const key = `fast-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const seen = async () => {
      return ((await thread.state()).seen as string[] | undefined) ?? [];
    };

    await ctx.send("msg", { thread: key, text: "m0" });
    await sleep(2500);

    // Spaced closely, so the next wait is often written while the previous one is being cleaned up.
    for (let n = 1; n < messages; n++) {
      await thread.send(`m${n}`);
      await sleep(15);
    }

    const all = await ctx.until(
      seen,
      (s) => {
        return s.length === messages;
      },
      60_000,
    );

    ctx.check(
      "every message woke the reader, once each",
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
