/**
 * @module
 * Proves the config resolver in a function: a `channel` that is an async
 * function of the event, chosen with a lookup in a `step.run`, resolved lazily
 * on first use, while `title` resolves eagerly. The function re-runs on every
 * replay, so only the plain choice crosses the step.
 */
import { createConfigResolver } from "inngest/experimental";
import { scenario } from "../kit/driver.ts";

type Choice = "slack" | "github";

export const configResolver = scenario({
  id: "config-resolver",
  functions: ({ client, event, fakes }) => {
    const post = async (path: string, body: unknown) => {
      await fetch(`${fakes.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    };

    return [
      client.createFunction(
        { id: "config-resolver-fn", triggers: [{ event: event("go") }] },
        async ({ event: trigger, step }) => {
          const resolver = createConfigResolver({
            config: {
              title: "build is green",
              channel: async (ctx: { team: string }) => {
                return await step.run("pick-channel", () => {
                  const choice: Choice =
                    ctx.team === "oss" ? "github" : "slack";

                  return choice;
                });
              },
            },
            ctx: { team: String(trigger.data.team) },
            modes: { title: "eager", channel: "lazy" },
          });
          const { title } = await resolver.ready();
          const channel = await resolver.get("channel");

          await step.run("announce", async () => {
            if (channel === "github") {
              await post("/github/repos/acme/app/issues/7/comments", {
                body: title,
              });

              return;
            }

            await post("/slack/api/chat.postMessage", {
              channel: "C1",
              text: title,
            });
          });

          return { channel };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const eng = await ctx.finished(await ctx.send("go", { team: "eng" }));
    const oss = await ctx.finished(await ctx.send("go", { team: "oss" }));

    ctx.expect.run(eng).toComplete();
    ctx.expect.run(eng).toHaveSteps("pick-channel", "announce");
    ctx.expect.run(eng).toOutput({ channel: "slack" });
    ctx.expect.run(oss).toComplete();
    ctx.expect.run(oss).toOutput({ channel: "github" });
    await ctx.expect
      .posts({ channel: "slack", method: "chat.postMessage" })
      .toHaveCount(1);
    await ctx.expect
      .posts({ channel: "slack", method: "chat.postMessage" })
      .toInclude({ text: "build is green" });
    await ctx.expect
      .posts({ channel: "github", thread: "acme/app#7" })
      .toHaveCount(1);
  },
});
