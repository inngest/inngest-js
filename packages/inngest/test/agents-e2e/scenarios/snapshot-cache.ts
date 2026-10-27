/**
 * @module
 * Proves the snapshot cache on the fake Sandboxes API: an entry is baked once
 * under `<scope>/<key>/<generation>`, found by name on the next run, and a new
 * generation builds again and replaces the old snapshot.
 */
import { type DurableSandbox, snapshotCache } from "inngest/experimental";
import { scenario } from "../kit/driver.ts";

export const snapshotCacheScenario = scenario({
  id: "snapshot-cache",
  owner: "piece-snapshot-cache",
  sandbox: "fake",
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "snapshot-cache-fn", triggers: [{ event: event("bake") }] },
        async ({ event: trigger, step, group }) => {
          const cache = snapshotCache(client, {
            memo: (id, fn) => {
              return step.run(id, fn);
            },
          });
          const entry = {
            scope: "skills",
            key: trigger.data.key as string,
            generation: trigger.data.sha as string,
          };

          const found = await cache.find(entry, { stepId: "lookup" });

          if (found) {
            return { built: false, name: found.name };
          }

          const taken = await group.sandbox(
            "bake",
            async (sandbox: DurableSandbox) => {
              await sandbox.commands.run("clone", "git clone skills");

              return cache.take(
                entry,
                (name, attempt) => {
                  return sandbox.snapshot(`save:${attempt}`, { name });
                },
                { stepId: "take" },
              );
            },
          );

          return { built: true, name: taken.name };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const key = `acme/skills-${Date.now()}`;
    const bake = async (sha: string) => {
      return ctx.finished(await ctx.send("bake", { key, sha }));
    };

    const first = await bake("sha1");

    ctx.expect.run(first).toComplete();
    ctx.expect.run(first).toOutput({ built: true, name: `skills/${key}/sha1` });
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.create" })
      .toHaveCount(1);

    const second = await bake("sha1");

    ctx.expect.run(second).toComplete();
    ctx.expect
      .run(second)
      .toOutput({ built: false, name: `skills/${key}/sha1` });
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.create" })
      .toHaveCount(1);

    const third = await bake("sha2");

    ctx.expect.run(third).toComplete();
    ctx.expect.run(third).toOutput({ built: true, name: `skills/${key}/sha2` });
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.create" })
      .toHaveCount(2);
    await ctx.expect
      .posts({ channel: "sandbox", method: "snapshot.delete" })
      .toInclude({ name: `skills/${key}/sha1` });
  },
});
