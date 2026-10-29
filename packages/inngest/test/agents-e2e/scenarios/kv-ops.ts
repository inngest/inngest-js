/**
 * @module
 * Scoped KV operations a Redis-backed app relies on: keys with a time to live,
 * set-if-absent claims and a sorted index, all step-backed inside a function.
 */
import {
  createKv,
  kv,
  kvKey,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";

export const kvOps = scenario({
  id: "kv-ops",
  owner: "agents-kv-ops",
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "kv-ops-fn", triggers: [{ event: event("go") }] },
        async ({ event: trigger }) => {
          const tag = (trigger.data as { tag: string }).tag;
          const env = kv.env;

          const first = await env.setIfAbsent(`${tag}:claim`, "a", { ttl: 2 });
          const second = await env.setIfAbsent(`${tag}:claim`, "b", {
            ttl: 2,
          });
          await env.set(`${tag}:marker`, "m", { ttl: 2 });

          const index = env.index(`${tag}:runs`);
          await index.add("old", 1);
          await index.add("new", 3);
          await index.add("mid", 2);
          const newest = await index.range({ order: "desc", limit: 2 });
          await index.remove("old");
          const rest = await index.range();

          return { first, second, newest, rest };
        },
      ),
      client.createFunction(
        { id: "kv-ops-read", triggers: [{ event: event("read") }] },
        async ({ event: trigger }) => {
          const tag = (trigger.data as { tag: string }).tag;

          return {
            claim: await kv.env.get(`${tag}:claim`),
            marker: await kv.env.get(`${tag}:marker`),
            reclaimed: await kv.env.setIfAbsent(`${tag}:claim`, "c"),
          };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const tag = `t${Date.now()}`;
    const run = await ctx.finished(
      await ctx.send("go", { tag }, { startsRun: true }),
    );

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toOutput({
      first: true,
      second: false,
      newest: [
        { member: "new", score: 3 },
        { member: "mid", score: 2 },
      ],
      rest: [
        { member: "mid", score: 2 },
        { member: "new", score: 3 },
      ],
    });

    // Updates from many callers at once, on the real Redis, lose none.
    const counter = createKv({ adapter: redisKvAdapter(ctx.redisUrl) }).with({
      id: "agents-e2e",
      env: null,
    }).env;
    const total = kvKey<number>(`${tag}:total`);

    await Promise.all(
      Array.from({ length: 15 }, () => {
        return counter.update(total, (n) => {
          return (n ?? 0) + 1;
        });
      }),
    );
    ctx.check(
      "15 concurrent updates all counted",
      (await counter.get(total)) === 15,
      await counter.get(total),
    );

    // After the ttl the keys are gone and the claim can be taken again.
    await ctx.eventually(
      "ttl keys expire and the claim is free",
      async () => {
        const read = await ctx.finished(
          await ctx.send("read", { tag }, { startsRun: true }),
        );

        return read;
      },
      (read) => {
        const out = (
          read as { output?: { claim?: unknown; reclaimed?: boolean } }
        ).output;

        return out?.claim == null && out?.reclaimed === true;
      },
    );
  },
});
