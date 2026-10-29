/**
 * @module
 * A cron-triggered agent: one thread per agent by default (its ID), a tick
 * while a run is live starts nothing, and a stop now cancels the run.
 */
import { Inngest } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  kvKey,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";

const agentId = "cron-agent";
const ref = `agents-e2e/${agentId}`;

const list = (state: Record<string, unknown>, key: string) => {
  return (state[key] as string[] | undefined) ?? [];
};

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const agentsCron = scenario({
  id: "agents-cron",
  owner: "agents-event-types",
  needs: { oss: "jack/step-subscribe" },

  // Ticks are minute-aligned: up to a minute to the first, a wait for the
  // next to pass, and up to a minute to the one after a stop now.
  capMs: 270_000,
  functions: ({ client }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        on: {
          cron: "* * * * *",
          message: (tick) => {
            return `tick ${tick.data.cron}`;
          },
        },
      },
      async ({ inbox }) => {
        await kv.thread.update(kvKey<number>("runs"), (runs) => {
          return (runs ?? 0) + 1;
        });

        for await (const message of inbox) {
          await kv.thread.update(kvKey<string[]>("turns"), (turns) => {
            return [...(turns ?? []), `${message.name}: ${message.content}`];
          });
          await sleep(120_000);
        }
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const thread = getThread(client, ref, agentId, { kv: store });
    const keys = async () => {
      return (await thread.state()).keys;
    };

    // The first tick is at most a minute away.
    const first = await ctx.until(
      keys,
      (s) => {
        return list(s, "turns").length === 1;
      },
      90_000,
    );
    ctx.check(
      "a tick starts the agent's own thread, with the typed message",
      list(first, "turns")[0] === "inngest/scheduled.timer: tick * * * * *",
      first,
    );

    // The next tick comes while the run is live: skipped, not delivered.
    await sleep(65_000);
    const live = await keys();
    ctx.check(
      "a tick while a run is live starts nothing",
      live.runs === 1 && list(live, "turns").length === 1,
      live,
    );

    await thread.stop({ when: "now" });
    const again = await ctx.until(
      keys,
      (s) => {
        return s.runs === 2;
      },
      90_000,
    );
    ctx.check(
      "the next tick after a stop now starts a new run",
      again.runs === 2,
      again,
    );
  },
});
