/**
 * @module
 * Proves the snapshot cache makes room at the snapshot limit: with room for
 * three snapshots, taking a fourth deletes the least recently created one of
 * an evictable scope in the process that could not snapshot, then succeeds.
 */
import { type DurableSandbox, snapshotCache } from "inngest/experimental";
import { scenario } from "../kit/driver.ts";

export const snapshotEvictScenario = scenario({
  id: "snapshot-evict",
  owner: "piece-snapshot-evict",
  sandbox: "fake",
  sandboxSnapshotLimit: { prefix: "evict-kit/", max: 3 },
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        {
          id: "snapshot-evict-fn",
          retries: 0,
          triggers: [{ event: event("bake") }],
        },
        async ({ event: trigger, step, group }) => {
          const cache = snapshotCache(client, {
            memo: (id, fn) => {
              return step.run(id, fn);
            },
            evict: { scopes: ["evict-kit"] },
          });
          const entry = {
            scope: "evict-kit",
            key: trigger.data.key as string,
            generation: "g1",
          };

          const taken = await group.sandbox(
            "bake",
            async (sandbox: DurableSandbox) => {
              return cache.take(
                entry,
                (name, attempt) => {
                  return sandbox.snapshot(`save:${attempt}`, { name });
                },
                { stepId: "take" },
              );
            },
          );

          return { name: taken.name, named: taken.named };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = Date.now();
    const keys = ["a", "b", "c", "d"].map((key) => {
      return `${key}-${run}`;
    });

    for (const key of keys) {
      const finished = await ctx.finished(await ctx.send("bake", { key }));

      ctx.expect.run(finished).toComplete();
      ctx.expect
        .run(finished)
        .toOutput({ name: `evict-kit/${key}/g1`, named: true });
    }

    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.create" })
      .toHaveCount(4);
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.delete" })
      .toInclude({ name: `evict-kit/${keys[0]}/g1` });
  },
});
