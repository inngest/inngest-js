/**
 * @module
 * The thread handle from outside and from another thread: steer a running
 * thread, read its state, stop it at the next turn, and ask one thread from
 * another (an inbox message plus a reply signal).
 */
import { Inngest } from "inngest";
import { tool } from "inngest/experimental";
import {
  agent,
  createAgents,
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario, script } from "../kit/driver.ts";

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const think = tool.step({
  description: "Thinks for a moment",
  input: z.object({}),
  run: async () => {
    await sleep(700);

    return "done thinking";
  },
});

const workerId = "th-worker";
const workerRef = `agents-e2e/${workerId}`;
const askerId = "th-asker";
const askerRef = `agents-e2e/${askerId}`;

export const threadHandle = scenario({
  id: "thread-handle",
  owner: "agents-thread-handle",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client }) => {
    const agents = createAgents(client);
    const worker = agents.agent(
      { id: workerId },
      async ({ inbox, thread, control }) => {
        for await (const message of inbox) {
          if (message.kind === "request") {
            const { n } = message.payload as { n: number };
            await message.reply({ answer: n * 2, by: thread.key });

            continue;
          }

          const result = await agent.loop({
            id: `turn${message.seq}`,
            model: script([
              { call: { name: "think", input: {} } },
              { say: "echo: {{last}}" },
            ]),
            prompt: message.content ?? "",
            tools: { think },
            ...control,
          });
          await kv.thread.set("last", { text: result.text });

          if (result.stopped === "stopped") {
            return "stopped";
          }
        }

        return "closed";
      },
    );

    // Asks the worker thread named in the message, from inside this function.
    const asker = agents.agent({ id: askerId }, async ({ inbox }) => {
      const message = await inbox.next();
      const [key, n] = (message?.content ?? "").split(":") as [string, string];
      const reply = await worker
        .thread(key)
        .request({ n: Number(n) }, { timeout: "1m" });
      await kv.thread.set("reply", reply);
    });

    return agents.functions();
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const key = `worker-${Date.now()}`;
    const worker = getThread(client, workerRef, key, { kv: store });

    const idle = await worker.state();
    ctx.check(
      "a thread that was never messaged is idle with empty state",
      idle.status === "idle" &&
        idle.turn === 0 &&
        idle.summary === undefined &&
        idle.usage.input === 0 &&
        Object.keys(idle.keys).length === 0,
      idle,
    );

    // A turn in flight shows as running, with the turn and usage so far.
    await worker.send("work");
    await ctx.eventually("state shows the running turn", worker.state, (s) => {
      return s.status === "running" && s.turn === 1 && s.usage.input === 10;
    });

    // A steer sent mid-turn is folded into the turn; the run then waits.
    await worker.steer("faster please");
    const waiting = await ctx.eventually(
      "state shows the finished turn, waiting for the next message",
      worker.state,
      (s) => {
        return (
          s.status === "waiting" &&
          s.summary === "echo: faster please" &&
          s.turn === 2 &&
          s.usage.input === 20 &&
          s.usage.output === 10
        );
      },
    );
    ctx.check(
      "state keys are the user's keys only",
      JSON.stringify(Object.keys(waiting.keys)) === JSON.stringify(["last"]),
      waiting,
    );

    // stop nextTurn lets the running model call finish and ends the thread.
    await worker.send("long");
    await ctx.until(worker.state, (s) => {
      return s.status === "running" && s.turn >= 1;
    });
    await worker.stop({ when: "nextTurn" });
    await ctx.eventually(
      "the thread stops at the next turn",
      worker.state,
      (s) => {
        return s.status === "stopped";
      },
    );

    // Another thread asks this one, which has no live run: the request wakes it.
    const asker = getThread(client, askerRef, `asker-${Date.now()}`, {
      kv: store,
    });
    await asker.send(`${key}:21`);
    await ctx.eventually(
      "a request to an idle thread is answered",
      asker.state,
      (s) => {
        const reply = s.keys.reply as { answer?: number; by?: string } | null;

        return reply?.answer === 42 && reply.by === key;
      },
    );

    // And a request to a live run is read from its inbox.
    await ctx.until(worker.state, (s) => {
      return s.status === "waiting";
    });
    const second = getThread(client, askerRef, `asker2-${Date.now()}`, {
      kv: store,
    });
    await second.send(`${key}:5`);
    await ctx.eventually(
      "a request to a live thread is answered",
      second.state,
      (s) => {
        const reply = s.keys.reply as { answer?: number } | null;

        return reply?.answer === 10;
      },
    );
  },
});
