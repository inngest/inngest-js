/**
 * @module
 * An agent started by an event an app already sends, defined with core's
 * `eventType()`: another app sends it, the agent's thread comes from its
 * data, and a second event for the same thread reaches the live run as a
 * message. Data that breaks the event type's schema is rejected on send.
 */
import { eventType, Inngest } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario } from "../kit/driver.ts";

const agentId = "app-event-agent";
const ref = `agents-e2e/${agentId}`;

const orderEvent = (name: string) => {
  return eventType(name, {
    schema: z.object({ id: z.string(), note: z.string() }),
  });
};

const list = (state: Record<string, unknown>, key: string) => {
  return (state[key] as string[] | undefined) ?? [];
};

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const agentsAppEvent = scenario({
  id: "agents-app-event",
  owner: "agents-event-types",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);
    const order = orderEvent(event("order"));

    agents.agent(
      {
        id: agentId,
        on: [
          {
            event: order,
            if: "event.data.id != 'ignored'",
            thread: "event.data.id",
            message: (trigger) => {
              return `order ${trigger.data.id}: ${trigger.data.note}`;
            },
          },
        ],
      },
      async ({ inbox }) => {
        await kv.thread.update<number>("runs", (runs) => {
          return (runs ?? 0) + 1;
        });

        for await (const message of inbox) {
          await kv.thread.update<string[]>("turns", (turns) => {
            return [...(turns ?? []), message.data.content ?? ""];
          });
          await sleep(100);
        }
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const other = new Inngest({
      id: "agents-e2e-other-app",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const order = orderEvent(ctx.event("order"));
    const key = `o${Date.now()}`;
    const thread = getThread(
      new Inngest({ id: "agents-e2e", baseUrl: ctx.devUrl, isDev: true }),
      ref,
      key,
      { kv: store },
    );
    const keys = async () => {
      return (await thread.state()).keys;
    };

    await other.send(order.create({ id: key, note: "first" }));
    await ctx.eventually(
      "an event from another app starts the thread",
      keys,
      (s) => {
        return list(s, "turns").includes(`order ${key}: first`);
      },
    );

    await other.send(order.create({ id: key, note: "second" }));
    const state = await ctx.eventually(
      "a second event reaches the live run as a message",
      keys,
      (s) => {
        return list(s, "turns").includes(`order ${key}: second`);
      },
    );
    ctx.check("one run for the thread", state.runs === 1, state);

    // Core rejects an event that breaks the schema for a run it would start;
    // the live run drops it the same way and carries on with the next one.
    await sleep(2000);
    await ctx.send("order", { id: key, note: "third" });
    const after = await ctx.eventually(
      "an event that breaks the schema is dropped and the next one delivered",
      keys,
      (s) => {
        return list(s, "turns").includes(`order ${key}: third`);
      },
    );
    ctx.check(
      "the invalid event was not delivered",
      list(after, "turns").length === 3 && after.runs === 1,
      after,
    );

    await other.send(order.create({ id: "ignored", note: "skipped" }));
    await sleep(3000);
    ctx.check(
      "an event the `if` rejects starts nothing",
      (
        await getThread(
          new Inngest({ id: "agents-e2e", baseUrl: ctx.devUrl, isDev: true }),
          ref,
          "ignored",
          { kv: store },
        ).state()
      ).status === "idle",
    );

    let rejected = false;
    try {
      await other.send(
        order.create({ id: key } as unknown as { id: string; note: string }),
      );
    } catch {
      rejected = true;
    }
    ctx.check("data that breaks the schema is rejected on send", rejected);
  },
});
