/**
 * @module
 * Channel limits: an agent reports 100 task cards to a Slack thread through
 * `report.card()`. The fake Slack holds 50 unique cards per stream, drops the
 * 51st with a warning, and ends a stream once a card named `end-stream` is
 * written. The reporter rolls over at 40 cards with a summary card, starts a
 * new stream (without the history) when one ended, and the run never sees a
 * dropped update.
 */
import { agent, createAgents, slack } from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";

export const channelLimits = scenario({
  id: "channel-limits",
  owner: "agents-channel-limits",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event, fakes }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: "channel-limits-agent",
        on: { ...slack.thread({ in: ["C44"] }), event: event("slack") },
        channels: ({ event: trigger }) => {
          return {
            main: slack.channel(trigger, {
              in: ["C44"],
              apiUrl: `${fakes.url}/slack/api`,
            }),
          };
        },
      },
      async ({ inbox, report }) => {
        await inbox.next();

        for (let i = 1; i <= 100; i++) {
          await report.card({ id: `step-${i}`, title: `Step ${i}` });

          if (i === 60) {
            await report.card({ id: "end-stream", title: "The stream ends" });
          }
        }

        // Parallel tools write cards at once; the writes run in order.
        await Promise.all(
          [101, 102, 103].map((i) => {
            return report.card({ id: `step-${i}`, title: `Step ${i}` });
          }),
        );

        return { cards: 103 };
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const run = await ctx.finished(
      await ctx.send("slack", {
        channel: "C44",
        ts: `${Date.now()}.000100`,
        text: "go",
        user: "U1",
      }),
    );

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toOutput({ cards: 103 });

    const calls = ctx.fakes.posts({ channel: "slack" });
    const starts = calls.filter((c) => c.method === "chat.startStream");
    const appends = calls.filter((c) => c.method === "chat.appendStream");
    const accepted = [...starts, ...appends].filter((c) => {
      return c.body.accepted === true;
    });
    const held = Math.max(...accepted.map((c) => Number(c.body.held)));
    const ids = new Set(
      accepted.flatMap((c) => {
        return (c.body.chunks as { id?: string }[]).flatMap((chunk) => {
          return chunk.id ? [chunk.id] : [];
        });
      }),
    );

    ctx.check("no stream held more than 50 unique cards", held <= 50, held);
    ctx.check(
      "every card was written to some stream",
      Array.from({ length: 103 }, (_, i) => `step-${i + 1}`).every((id) => {
        return ids.has(id);
      }),
    );
    ctx.check(
      "streams were rolled over (at 40 cards, and after the one that ended)",
      starts.length >= 4,
      starts.length,
    );
    ctx.check(
      "a new stream begins with a summary and the card at hand, not the history",
      accepted.some((c) => {
        const chunks = (c.body.chunks as { id?: string }[]).filter((chunk) => {
          return chunk.id;
        });

        return chunks.length === 2 && chunks[0]?.id === "summary";
      }),
    );
    ctx.check(
      "no update was dropped",
      !appends.some((c) => c.body.accepted === false && c.body.held),
    );
  },
});
