/**
 * @module
 * Inbox sources. A live-only source reaches the run of the thread it maps to
 * and never starts one; `inbox.listen()` adds a source mid-run and `stop()`
 * removes it; `step.inbox()` is another inbox with a sequence of its own.
 */
import { Inngest, step } from "inngest";
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
import { withKeys } from "../kit/threads.ts";

const agentId = "inbox-sources-agent";
const ref = `agents-e2e/${agentId}`;

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const inboxSources = scenario({
  id: "inbox-sources",
  owner: "agents-inbox",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        inbox: [{ event: event("ci"), thread: "event.data.t" }],
      },
      async ({ inbox, thread }) => {
        const record = async (line: string) => {
          await kv.thread.update(kvKey<string[]>("seen"), function (seen) {
            return [...(seen ?? []), line];
          });
        };
        let listener: Awaited<ReturnType<typeof inbox.listen>> | undefined;

        for await (const message of inbox) {
          const content = message.data.content ?? "";
          const source = message.data.event?.name;

          if (source === event("ci")) {
            await record("ci");
          } else if (source === event("late")) {
            await record("late");
          } else if (content === "listen") {
            await record("message:listen");
            listener = await inbox.listen(event("late"), {
              thread: "event.data.t",
            });
          } else if (content === "unlisten") {
            await record("message:unlisten");
            await listener?.stop();
          } else if (content === "second") {
            await record("message:second");

            const second = await step.inbox("second", {
              sources: [
                {
                  event: event("two"),
                  if: `async.data.t == "${thread.key}"`,
                },
              ],
            });
            const got = await second.next({ timeout: "30s" });

            await record(
              `second:${got?.name === event("two") ? "two" : "none"}`,
            );
            await second.close();
          } else {
            await record(`message:${content}`);
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
    const key = `sources-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const seen = async () => {
      return ((await thread.state()).seen as string[] | undefined) ?? [];
    };
    const count = (lines: string[], line: string) => {
      return lines.filter((l) => {
        return l === line;
      }).length;
    };
    const send = async (name: string) => {
      const { ids } = await client.send({
        name: ctx.event(name),
        data: { t: key },
      });

      return ids[0] as string;
    };

    // A live-only source never starts a run: this thread has none.
    const idle = await send("ci");

    await sleep(3000);
    ctx.check(
      "an event of a live-only source starts no run",
      (await ctx.runsOf(idle)).length === 0,
      await ctx.runsOf(idle),
    );

    // The thread starts from its own message, then the source reaches the run.
    await thread.send("hello");
    await ctx.until(seen, (s) => {
      return s.includes("message:hello");
    });
    await send("ci");
    const afterCi = await ctx.until(seen, (s) => {
      return s.includes("ci");
    });

    ctx.check(
      "a live-only source reaches the running thread, once",
      count(afterCi, "ci") === 1,
      afterCi,
    );

    // A source added mid-run hears only from then on, and stop() ends it.
    await send("late");
    await sleep(1500);
    await thread.send("listen");
    await ctx.until(seen, (s) => {
      return s.includes("message:listen");
    });
    await sleep(1500);
    await send("late");
    await ctx.until(seen, (s) => {
      return s.includes("late");
    });
    await thread.send("unlisten");
    await ctx.until(seen, (s) => {
      return s.includes("message:unlisten");
    });
    await sleep(1500);
    await send("late");
    await sleep(2500);

    const afterLate = await seen();

    ctx.check(
      "listen() hears from then on and stop() ends it",
      count(afterLate, "late") === 1,
      afterLate,
    );

    // Another inbox has a sequence of its own.
    await thread.send("second");
    await ctx.until(seen, (s) => {
      return s.includes("message:second");
    });
    await sleep(1500);
    await send("two");

    const afterTwo = await ctx.until(seen, (s) => {
      return s.some((l) => {
        return l.startsWith("second:");
      });
    });

    ctx.check(
      "a second inbox reads its own source, which the main inbox never sees",
      afterTwo.includes("second:two") && count(afterTwo, "two") === 0,
      afterTwo,
    );
  },
});
