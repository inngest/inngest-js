/**
 * @module
 * A message is acked when its turn is over, so a run that fails in the middle
 * of a turn leaves the message for the thread's next run, which handles it
 * exactly once.
 */
import { Inngest, NonRetriableError } from "inngest";
import {
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const list = (state: Record<string, unknown>, key: string) => {
  return (state[key] as string[] | undefined) ?? [];
};

export const agentsRedelivery = scenario({
  id: "agents-redelivery",
  owner: "agents-f",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client }) => {
    const agent = client.agent(
      { id: "agents-redeliver" },
      async ({ inbox }) => {
        for await (const message of inbox) {
          const content = message.data.content ?? "";
          const started = await kv.thread.update<string[]>(
            "started",
            function (found) {
              return [...(found ?? []), content];
            },
          );
          await sleep(1200);

          // The first time the thread sees m1, the run fails mid-turn.
          if (
            content === "m1" &&
            started.filter((item) => {
              return item === "m1";
            }).length === 1
          ) {
            throw new NonRetriableError("fails while handling m1");
          }

          await kv.thread.update<string[]>("done", function (found) {
            return [...(found ?? []), content];
          });
        }
      },
    );

    return agent.functions;
  },
  run: async (ctx) => {
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const thread = withKeys(
      getThread(
        client,
        "agents-e2e/agents-redeliver",
        `redeliver-${Date.now()}`,
        { kv: createKv({ adapter: redisKvAdapter(ctx.redisUrl) }) },
      ),
    );

    await thread.send("m0");
    await ctx.eventually("m0 handled", thread.state, (s) => {
      return list(s, "done").includes("m0");
    });
    await thread.send("m1");

    const state = await ctx.eventually(
      "m1 is redelivered to the next run and handled",
      thread.state,
      (s) => {
        return list(s, "done").includes("m1");
      },
    );
    ctx.check(
      "the failed turn started m1 twice and finished it once",
      JSON.stringify(list(state, "started")) ===
        JSON.stringify(["m0", "m1", "m1"]) &&
        JSON.stringify(list(state, "done")) === JSON.stringify(["m0", "m1"]),
      state,
    );

    // The republish retries must not start m1 a third time.
    await sleep(10_000);
    const settled = await thread.state();
    ctx.check(
      "no further redelivery",
      list(settled, "started").length === 3 &&
        list(settled, "done").length === 2,
      settled,
    );
  },
});
