/**
 * @module
 * `inbox.listen()` returns the scoped view of its event: the run reads the
 * source with `inbox.listen(...)` and
 * `deploys.next({ timeout })`, with a cursor of its own, while the main inbox
 * receives the events too, and leaving the scope stops the source.
 */
import { Inngest } from "inngest";
import {
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

const agentId = "inbox-listener-view-agent";
const ref = `agents-e2e/${agentId}`;

export const inboxListenerView = scenario({
  id: "inbox-listener-view",
  owner: "agents-inbox",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent({ id: agentId }, async ({ inbox }) => {
      const record = async (line: string) => {
        await kv.thread.update(kvKey<string[]>("seen"), function (seen) {
          return [...(seen ?? []), line];
        });
      };

      for await (const message of inbox) {
        if (message.name === event("deploy")) {
          await record(`main:${(message.data as unknown as { n: number }).n}`);
        } else if (textOf(message) === "wait") {
          await record("message:wait");

          const deploys = await inbox.listen(event("deploy"), {
            if: `async.data.service == "api"`,
          });

          try {
            const done = await deploys.next({ timeout: "60s" });

            await record(
              `view:${(done?.data as { n: number } | undefined)?.n}`,
            );
          } finally {
            await deploys[Symbol.asyncDispose]();
          }

          await record("scope:left");
        }
      }
    });

    return agents.functions();
  },
  run: async (ctx) => {
    const store: Kv = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const key = `listener-view-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const seen = async () => {
      return ((await thread.state()).seen as string[] | undefined) ?? [];
    };
    const deploy = async (service: string, n: number) => {
      await client.send({
        name: ctx.event("deploy"),
        data: { service, n },
      });
    };
    const sleep = (ms: number) => {
      return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    };

    await thread.send("wait");
    await ctx.until(seen, (s) => {
      return s.includes("message:wait");
    });
    await sleep(1500);
    await deploy("web", 1);
    await deploy("api", 2);

    const after = await ctx.until(seen, (s) => {
      return s.includes("scope:left");
    });

    ctx.check(
      "the listener's next() waits for the filtered event and the main inbox gets it too",
      after.includes("view:2") && after.includes("main:2"),
      after,
    );

    ctx.check(
      "an event the filter drops reaches neither the view nor the main inbox",
      !after.includes("view:1") && !after.includes("main:1"),
      after,
    );

    await sleep(1500);
    await deploy("api", 3);
    await sleep(2500);

    const afterScope = await seen();

    ctx.check(
      "leaving the scope stops the source",
      !afterScope.includes("main:3"),
      afterScope,
    );
  },
});
