/**
 * @module
 * A message that arrives while the run is executing a step does not run that
 * step twice. Every execution of the step body is recorded outside any step,
 * and each message's work must have run exactly once.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inngest, step } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  kvKey,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

const agentId = "subscribe-busy-agent";
const ref = `agents-e2e/${agentId}`;

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const ranFile = (thread: string) => {
  return join(tmpdir(), `subscribe-busy-${thread}.log`);
};

export const subscribeBusy = scenario({
  id: "subscribe-busy",
  owner: "agents-thread-key",
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        on: {
          event: event("msg"),
          thread: "event.data.thread",
          message: (trigger) => {
            return trigger.data.text as string;
          },
        },
      },
      async ({ inbox, thread }) => {
        for await (const message of inbox) {
          await step.run("work", async () => {
            appendFileSync(ranFile(thread.key), `${message.content}\n`);
            await sleep(2500);
          });
          await kv.thread.update(kvKey<string[]>("done"), function (done) {
            return [...(done ?? []), message.content ?? ""];
          });
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
    const key = `busy-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const done = async () => {
      return ((await thread.state()).done as string[] | undefined) ?? [];
    };

    await ctx.send("msg", { thread: key, text: "m0" });
    await ctx.until(done, (d) => {
      return d.length === 1;
    });

    // Each lands while the previous message's work step is running.
    for (const text of ["m1", "m2", "m3"]) {
      await sleep(600);
      await thread.send(text);
    }
    await ctx.until(
      done,
      (d) => {
        return d.length === 4;
      },
      60_000,
    );
    await sleep(3000);

    const ran = existsSync(ranFile(key))
      ? readFileSync(ranFile(key), "utf8").trim().split("\n")
      : [];
    if (existsSync(ranFile(key))) {
      unlinkSync(ranFile(key));
    }

    ctx.check(
      "each message's work ran exactly once",
      JSON.stringify([...ran].sort()) ===
        JSON.stringify(["m0", "m1", "m2", "m3"]),
      ran,
    );
  },
});
