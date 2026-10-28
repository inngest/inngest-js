/**
 * @module
 * Channels: an agent triggered by a Slack event reports progress to the
 * Slack thread it started in and to a GitHub comment chosen from the event,
 * and renders an ask through the Slack channel. Slack and GitHub are the fakes.
 */
import { Inngest, step } from "inngest";
import {
  agent,
  askThrough,
  type Channel,
  createAgents,
  createKv,
  getThread,
  github,
  kv,
  redisKvAdapter,
  slack,
} from "inngest/experimental/agents";
import { scenario, script } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

export const channels = scenario({
  id: "channels",
  owner: "agents-channels",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client, event, fakes }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: "channels-agent",
        on: { ...slack.thread(), event: event("slack") },
        channels: ({ event: trigger }): Record<string, Channel> => {
          // The event is the Slack one; its text names the pull request: "acme/app#7".
          const data = trigger.data as unknown as { text: string };
          const [, owner, repo, number] =
            /([\w-]+)\/([\w-]+)#(\d+)/.exec(data.text) ?? [];
          const main = slack.channel(trigger, {
            apiUrl: `${fakes.url}/slack/api`,
          });

          return owner && repo && number
            ? {
                main,
                pr: github.channel(
                  { owner, repo, number: Number(number) },
                  { apiUrl: `${fakes.url}/github` },
                ),
              }
            : { main };
        },
        report: ["main", "pr"],
      },
      async ({ inbox, report, channels: destinations }) => {
        const first = await inbox.next();

        await report("starting");

        const result = await agent.loop({
          model: script([{ say: "all done" }]),
          prompt: first?.data.content ?? "",
          tools: {},
        });

        await step.run("ask-1", async () => {
          await askThrough(destinations.main as Channel, {
            signal: "ask-1",
            question: "Open the PR?",
            options: ["open", "skip"],
          });
        });
        await report({ text: result.text, kind: "result" });

        return { text: result.text };
      },
    );

    // A GitHub comment trigger: its thread key is evaluated by the Dev Server
    // (singleton, inbox filter) and by the SDK, and the two must agree.
    agents.agent(
      {
        id: "channels-github-agent",
        on: { ...github.comment(), event: event("gh") },
      },
      async ({ inbox, thread }) => {
        for (let i = 0; i < 2; i++) {
          const message = await inbox.next();

          await kv.thread.update<string[]>("texts", (texts) => {
            return [...(texts ?? []), message?.data.content ?? ""];
          });
        }

        return { thread: thread.key };
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const ts = `${Date.now()}.000100`;

    const run = await ctx.finished(
      await ctx.send("slack", {
        channel: "C42",
        ts,
        text: "please look at acme/app#7",
      }),
    );

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toOutput({ text: "all done" });
    await ctx.expect
      .posts({ channel: "slack", method: "chat.postMessage", thread: ts })
      .toHaveCount(3);
    await ctx.expect
      .posts({ channel: "slack", thread: ts })
      .toInclude({ text: "starting", channel: "C42" });
    await ctx.expect
      .posts({ channel: "slack", thread: ts })
      .toInclude({ text: "Open the PR?" });
    await ctx.expect
      .posts({ channel: "github", thread: "acme/app#7" })
      .toHaveCount(2);
    await ctx.expect
      .posts({ channel: "github", thread: "acme/app#7" })
      .toInclude({ body: "all done" });

    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const issue = { owner: "acme", repo: "keys", number: "12" };
    const handle = withKeys(
      getThread(
        client,
        "agents-e2e/channels-github-agent",
        "github:acme/keys#12",
        {
          kv: createKv({ adapter: redisKvAdapter(ctx.redisUrl) }),
        },
      ),
    );

    await ctx.send("gh", { ...issue, body: "one" });
    await ctx.eventually(
      "the first comment is a turn",
      handle.state,
      (state) => {
        return JSON.stringify(state.texts) === '["one"]';
      },
    );
    await ctx.send("gh", { ...issue, body: "two" });
    await ctx.eventually(
      "the second comment reaches the same thread's run",
      handle.state,
      (state) => {
        return JSON.stringify(state.texts) === '["one","two"]';
      },
    );
  },
});
