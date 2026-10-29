/**
 * @module
 * A run started by an `on` event ends when its body returns. The body reads the
 * trigger and one more event from the same `on` stream, then returns, so the
 * last thing it did was wait for a message that came from the `on` stream.
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
import { withKeys } from "../kit/threads.ts";

const agentId = "subscribe-finish-agent";
const ref = `agents-e2e/${agentId}`;

export const subscribeFinish = scenario({
  id: "subscribe-finish",
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
          message: (trigger) => {
            return trigger.data.text as string;
          },
        },
      },
      async ({ inbox }) => {
        const first = await inbox.next();
        const second = await inbox.next();

        await kv.thread.set("read", [
          first?.content ?? null,
          second?.content ?? null,
        ]);

        return "done";
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
    const key = `finish-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));

    const started = Date.now();
    const eventId = await ctx.send("msg", { thread: key, text: "one" });
    // The run is waiting on its inbox before the second event is sent.
    await new Promise((resolve) => {
      setTimeout(resolve, 3000);
    });
    await ctx.send("msg", { thread: key, text: "two" });
    await ctx.eventually("both are read", thread.state, (s) => {
      return (s.read as string[] | undefined)?.length === 2;
    });

    const run = await ctx.finished(eventId);
    const took = Date.now() - started;

    ctx.expect.run(run).toComplete();
    ctx.check("the run ends soon after the body returns", took < 20_000, took);
  },
});
