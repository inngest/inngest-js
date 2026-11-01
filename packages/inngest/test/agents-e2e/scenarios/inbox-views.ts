/**
 * @module
 * Views of an inbox. A view reads the messages of one event with a cursor of
 * its own: reading through it hides nothing from the main loop, and its
 * `unread()` takes what came after its cursor.
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

const agentId = "inbox-views-agent";
const ref = `agents-e2e/${agentId}`;

export const inboxViews = scenario({
  id: "inbox-views",
  owner: "agents-inbox",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        inbox: [{ event: event("ci"), thread: "event.data.t" }],
      },
      async ({ inbox }) => {
        const record = async (line: string) => {
          await kv.thread.update(kvKey<string[]>("seen"), function (seen) {
            return [...(seen ?? []), line];
          });
        };
        const ci = inbox.of(event("ci"));

        // The trigger, then the first ci event through the view.
        await inbox.next();

        const got = await ci.next({ timeout: "60s" });

        await record(`view:${(got?.data as { n?: number } | undefined)?.n}`);

        for await (const message of inbox) {
          if (message.name === event("ci")) {
            await record(
              `main:ci:${(message.data as unknown as { n: number }).n}`,
            );
          } else if (textOf(message) === "unread") {
            const rest = await ci.unread();

            await record(
              `unread:${rest
                .map((m) => {
                  return (m.data as { n: number }).n;
                })
                .join(",")}`,
            );
          }
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
    const key = `views-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const seen = async () => {
      return ((await thread.state()).seen as string[] | undefined) ?? [];
    };
    const ci = async (n: number) => {
      await client.send({ name: ctx.event("ci"), data: { t: key, n } });
    };
    const sleep = (ms: number) => {
      return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    };

    await thread.send("hello");
    await sleep(2000);
    await ci(1);

    const afterFirst = await ctx.until(seen, (s) => {
      return s.includes("view:1") && s.includes("main:ci:1");
    });

    ctx.check(
      "the view reads the first event and the main loop still sees it",
      afterFirst.includes("view:1") && afterFirst.includes("main:ci:1"),
      afterFirst,
    );

    await ci(2);
    await ctx.until(seen, (s) => {
      return s.includes("main:ci:2");
    });
    await thread.send("unread");

    const done = await ctx.until(seen, (s) => {
      return s.some((l) => {
        return l.startsWith("unread:");
      });
    });

    ctx.check(
      "unread() of the view takes what came after its cursor",
      done.includes("unread:2"),
      done,
    );
  },
});
