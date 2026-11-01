/**
 * @module
 * An agent whose handler starts a `for await` reader over its inbox and does
 * not await it, then runs steps. One agent calls `inbox.close()`, awaits the
 * reader and sees it end; the other returns with the reader still waiting. The
 * run completes in both, and each step body runs once.
 */
import { eventType } from "inngest";
import { createAgents, kv } from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario } from "../kit/driver.ts";

const trigger = (name: string) => {
  return eventType(name, { schema: z.object({ id: z.string() }) });
};

export const agentsBackgroundReader = scenario({
  id: "agents-background-reader",
  owner: "sub-23-background-reader-v4",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);
    const closing = trigger(event("closing"));
    const returning = trigger(event("returning"));

    const handler = (closeIt: boolean) => {
      return async ({
        inbox,
        step,
      }: {
        inbox: AsyncIterable<unknown> & { close: () => Promise<unknown> };
        step: typeof import("inngest").step;
      }) => {
        const seen: unknown[] = [];

        const reader = (async () => {
          for await (const message of inbox) {
            seen.push(message);
          }

          return "ended";
        })();

        await step.run("work-a", () => {
          return "a";
        });
        await step.run("work-b", () => {
          return "b";
        });

        if (closeIt) {
          await inbox.close();
          await kv.thread.set("reader", await reader);
        }

        await kv.thread.set("finished", true);
      };
    };

    agents.agent(
      {
        id: "background-closing",
        on: [{ event: closing, thread: "event.data.id" }],
      },
      handler(true),
    );
    agents.agent(
      {
        id: "background-returning",
        on: [{ event: returning, thread: "event.data.id" }],
      },
      handler(false),
    );

    return agents.functions();
  },
  run: async (ctx) => {
    for (const name of ["closing", "returning"]) {
      const id = await ctx.send(
        name,
        { id: `${name}-${Date.now()}` },
        { startsRun: true },
      );
      const run = await ctx.finished(id);

      ctx.expect.run(run).toComplete();
      ctx.expect.run(run).toHaveSteps("work-a", "work-b");
    }
  },
});
