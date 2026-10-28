/**
 * @module
 * Proves the fake Slack and GitHub: a model-driven tool posts to each, and
 * the scenario asserts on what they received.
 */

import { tool } from "inngest/experimental";
import { agent } from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario, script } from "../kit/driver.ts";

export const channelsFake = scenario({
  id: "channels-fake",
  functions: ({ client, event, fakes }) => {
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${fakes.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      return (await res.json()) as { ts?: string };
    };
    const notify = tool.step({
      description: "Tells Slack and GitHub",
      input: z.object({ text: z.string() }),
      run: async ({ text }) => {
        const slack = await post("/slack/api/chat.postMessage", {
          channel: "C1",
          text,
        });

        await post("/slack/api/chat.postMessage", {
          channel: "C1",
          text: "again",
          thread_ts: slack.ts,
        });
        await post("/github/repos/acme/app/issues/7/comments", { body: text });

        return "sent";
      },
    });

    return [
      client.createFunction(
        { id: "channels-fake-fn", triggers: [{ event: event("go") }] },
        async () => {
          const result = await agent.loop({
            model: script([
              { call: { name: "notify", input: { text: "build is green" } } },
              { say: "told them" },
            ]),
            prompt: "announce",
            tools: { notify },
          });

          return { text: result.text };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(await ctx.send("go"));

    ctx.expect.run(run).toComplete();
    await ctx.expect
      .posts({ channel: "slack", method: "chat.postMessage" })
      .toHaveCount(2);
    await ctx.expect
      .posts({ channel: "slack", method: "chat.postMessage" })
      .toInclude({ text: "build is green" });
    await ctx.expect
      .posts({ channel: "github", thread: "acme/app#7" })
      .toInclude({ body: "build is green" });
    ctx.check(
      "the second Slack message is in the first one's thread",
      new Set(
        ctx.fakes.posts({ channel: "slack" }).map((call) => {
          return call.thread;
        }),
      ).size === 1,
      ctx.fakes.posts({ channel: "slack" }),
    );
  },
});
