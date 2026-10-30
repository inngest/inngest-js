/**
 * @module
 * A chat agent on `step.subscribe`: every message is a turn, steering and
 * stopping reach the running turn, a burst is processed once each, and
 * stopping an idle thread starts nothing.
 */
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
import { textOf } from "../kit/text.ts";
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
    await sleep(700);

    return "done thinking";
  },
});

const agentId = "agents-chat-agent";
const ref = `agents-e2e/${agentId}`;

const last = (state: Record<string, unknown>) => {
  return (state.last as { text?: string } | undefined)?.text;
};

export const agentsChat = scenario({
  id: "agents-chat",
  owner: "agents-f",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client }) => {
    const agents = createAgents(client);
    const chat = agents.agent({ id: agentId }, async ({ inbox, control }) => {
      for await (const message of inbox) {
        await kv.thread.update(kvKey<string[]>("started"), function (started) {
          return [...(started ?? []), textOf(message) ?? ""];
        });
        const history = await kv.thread.get(kvKey<never[]>("history"));
        const result = await agent.loop({
          id: `turn${message.seq}`,
          model: script([
            { call: { name: "think", input: {} } },
            { say: "echo: {{last}}" },
          ]),
          prompt: message,
          history: history ?? [],
          tools: { think },
          ...control,
        });

        await kv.thread.set("history", result.history);
        await kv.thread.set("last", { seq: message.seq, text: result.text });
        await kv.thread.update(kvKey<string[]>("turns"), function (turns) {
          return [...(turns ?? []), textOf(message) ?? ""];
        });
      }
    });

    return agents.functions();
  },
  run: async (ctx) => {
    const store: Kv = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const handle = (key: string) => {
      return withKeys(
        getThread(client, ref, `${key}-${Date.now()}`, { kv: store }),
      );
    };

    // A thread starts from its first message; the second reaches the waiting run.
    const t1 = handle("chat");
    await t1.send("hello");
    await ctx.eventually("first message answered", t1.state, (s) => {
      return last(s) === "echo: hello";
    });
    await t1.send("again");
    const second = await ctx.eventually(
      "second message answered",
      t1.state,
      (s) => {
        return last(s) === "echo: again";
      },
    );
    ctx.check(
      "history carries across turns",
      (second.history as unknown[] | undefined)?.length === 8,
      second,
    );

    // A steer sent mid-turn is folded into the running turn.
    await t1.send("work");
    await sleep(300);
    await t1.steer("faster please");
    await ctx.eventually(
      "steer is folded into the running turn",
      t1.state,
      (s) => {
        return last(s) === "echo: faster please";
      },
    );

    // A burst sent while a turn runs is processed exactly once each.
    await t1.send("b0");
    await sleep(200);
    for (const n of [1, 2, 3, 4]) {
      await t1.send(`b${n}`);
    }
    const burst = await ctx.until(
      t1.state,
      (s) => {
        return (
          ((s.turns as string[] | undefined) ?? []).filter((turn) => {
            return turn.startsWith("b");
          }).length >= 5
        );
      },
      40_000,
    );
    const turns = ((burst.turns as string[] | undefined) ?? []).filter(
      (turn) => {
        return turn.startsWith("b");
      },
    );
    ctx.check(
      "burst processed exactly once each",
      JSON.stringify([...turns].sort()) ===
        JSON.stringify(["b0", "b1", "b2", "b3", "b4"]),
      turns,
    );

    // stop now cancels the live run; a stop with no live run starts nothing.
    const before = ((await t1.state()).turns as string[]).length;
    await t1.stop({ when: "now" });
    await sleep(2000);
    await t1.stop({ when: "nextTurn" });
    await sleep(2000);
    ctx.check(
      "stop on an idle thread starts no run",
      ((await t1.state()).turns as string[]).length === before,
      await t1.state(),
    );

    const t2 = handle("stopnow");
    await t2.send("long");
    await ctx.until(t2.state, (s) => {
      return ((s.started as string[] | undefined) ?? []).includes("long");
    });
    await t2.stop({ when: "now" });
    await sleep(3000);
    ctx.check(
      "stop now cancels the running turn",
      (await t2.state()).turns === undefined,
      await t2.state(),
    );
  },
});
