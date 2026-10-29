/**
 * @module
 * A message that reaches a busy thread is acknowledged at once and folded into
 * the running turn at its next model call, with nothing wired in the app but
 * `onArrival` and `foldMessages`: `agent.loop` steers through the inbox itself,
 * and the folded message is not returned again by `next()`. A message sent to an
 * idle thread is a turn of its own and gets no arrival hook.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inngest } from "inngest";
import { tool } from "inngest/experimental";
import {
  agent,
  createAgents,
  createKv,
  getThread,
  type Kv,
  kv,
  kvKey,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario, script } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const think = tool.step({
  description: "Thinks for a moment",
  input: z.object({}),
  run: async () => {
    await sleep(1500);

    return "done thinking";
  },
});

const agentId = "inbox-arrival-agent";
const ref = `agents-e2e/${agentId}`;

const ackFile = (thread: string) => {
  return join(tmpdir(), `inbox-arrival-${thread}.log`);
};

const acks = (thread: string) => {
  return existsSync(ackFile(thread))
    ? readFileSync(ackFile(thread), "utf8").trim().split("\n")
    : [];
};

export const inboxArrival = scenario({
  id: "inbox-arrival",
  owner: "agents-inbox",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        foldMessages: "all",
        onArrival: async ({ message, thread }) => {
          appendFileSync(ackFile(thread), `${message.content}\n`);
        },
      },
      async ({ inbox }) => {
        for await (const message of inbox) {
          await kv.thread.update(kvKey<string[]>("turns"), function (turns) {
            return [...(turns ?? []), message.content ?? ""];
          });

          // No `...control`: the loop steers through the inbox on its own.
          const result = await agent.loop({
            id: `turn${message.seq}`,
            model: script([
              { call: { name: "think", input: {} } },
              { say: "echo: {{last}}" },
            ]),
            prompt: message.content ?? "",
            tools: { think },
          });

          await kv.thread.set("last", { seq: message.seq, text: result.text });
        }
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const store: Kv = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const key = `arrival-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const last = (state: Record<string, unknown>) => {
      return (state.last as { text?: string } | undefined)?.text;
    };

    // The first message starts the run: it is not an arrival.
    await thread.send("work");
    await ctx.until(thread.state, (s) => {
      return ((s.turns as string[] | undefined) ?? []).includes("work");
    });
    await sleep(400);

    // This one reaches the busy run.
    await thread.send("also this");
    await ctx.until(
      async () => {
        return acks(key);
      },
      (a) => {
        return a.includes("also this");
      },
      10_000,
    );

    const atAck = await thread.state();

    ctx.check(
      "the message is acknowledged before the turn ends",
      last(atAck) === undefined,
      atAck,
    );

    const done = await ctx.until(thread.state, (s) => {
      return last(s) !== undefined;
    });

    ctx.check(
      "the next model call carried the message",
      last(done) === "echo: also this",
      done,
    );

    await sleep(3000);

    const after = await thread.state();

    ctx.check(
      "the folded message is not a turn of its own",
      JSON.stringify(after.turns) === JSON.stringify(["work"]),
      after,
    );
    ctx.check(
      "only the message that reached a busy run was acknowledged",
      JSON.stringify(acks(key)) === JSON.stringify(["also this"]),
      acks(key),
    );

    if (existsSync(ackFile(key))) {
      unlinkSync(ackFile(key));
    }
  },
});
