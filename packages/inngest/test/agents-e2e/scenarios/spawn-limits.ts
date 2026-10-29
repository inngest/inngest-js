/**
 * @module
 * Spawn limits: a chain of three agents is refused at depth 2 by default and
 * allowed with `limits.depth: 2`, `mayCall` refuses an agent outside its
 * list, and a spent `budget` stops the loop with a reason.
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

const app = "agents-e2e";

/**
 * The message that starts an agent's thread when it is invoked.
 */
const start = (id: string, thread: string) => {
  return { agent: `${app}/${id}`, thread, kind: "user", content: "go" };
};

/**
 * Starts `id`, returns its output, or the refusal's message.
 */
const attempt = async (id: string, thread: string) => {
  try {
    return await agent.invoke<string>(`${app}/${id}`, start(id, thread));
  } catch (error) {
    return `REFUSED: ${(error as Error).message}`;
  }
};

const noop = tool.step({
  description: "Does nothing",
  input: z.object({}),
  run: async () => {
    return "ok";
  },
});

export const spawnLimits = scenario({
  id: "spawn-limits",
  owner: "agents-spawn-limits",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client }) => {
    const agents = createAgents(client);
    const first = async (inbox: { next(): Promise<unknown> }) => {
      await inbox.next();
    };

    agents.agent({ id: "sl-leaf" }, async ({ inbox }) => {
      await first(inbox);

      return "leaf";
    });

    // Default limits: this agent may start sub-agents, those may not.
    agents.agent({ id: "sl-mid" }, async ({ inbox, thread }) => {
      await first(inbox);

      return attempt("sl-leaf", `${thread.key}-leaf`);
    });
    agents.agent({ id: "sl-root" }, async ({ inbox, thread }) => {
      await first(inbox);
      await kv.thread.set(
        "result",
        await attempt("sl-mid", `${thread.key}-mid`),
      );
    });

    // depth 2: the chain is allowed.
    agents.agent(
      { id: "sl-root2", limits: { depth: 2 } },
      async ({ inbox, thread }) => {
        await first(inbox);
        await kv.thread.set(
          "result",
          await attempt("sl-mid", `${thread.key}-mid`),
        );
      },
    );

    // mayCall: only sl-leaf.
    agents.agent(
      { id: "sl-picky", limits: { mayCall: [`${app}/sl-leaf`] } },
      async ({ inbox, thread }) => {
        await first(inbox);
        await kv.thread.set("result", {
          denied: await attempt("sl-mid", `${thread.key}-mid`),
          allowed: await attempt("sl-leaf", `${thread.key}-leaf`),
        });
      },
    );

    // budget: 20 tokens, 15 per model call.
    agents.agent(
      { id: "sl-spender", limits: { budget: { tokens: 20 } } },
      async ({ inbox, control }) => {
        await first(inbox);
        const result = await agent.loop({
          model: script([
            { call: { name: "noop", input: {} } },
            { call: { name: "noop", input: {} } },
            { say: "never reached" },
          ]),
          prompt: "spend",
          tools: { noop },
          ...control,
        });
        await kv.thread.set("result", {
          stopped: result.stopped,
          reason: result.reason,
          turns: result.turns,
        });
      },
    );

    // dollars: $0.00002 at $1 per million tokens, 15 tokens (\$0.000015) per call.
    agents.agent(
      {
        id: "sl-dollars",
        limits: {
          budget: { usd: 0.00002 },
          price: { "*": { input: 1, output: 1 } },
        },
      },
      async ({ inbox, control }) => {
        await first(inbox);
        const result = await agent.loop({
          model: script([
            { call: { name: "noop", input: {} } },
            { call: { name: "noop", input: {} } },
            { say: "never reached" },
          ]),
          prompt: "spend dollars",
          tools: { noop },
          ...control,
        });
        await kv.thread.set("result", {
          stopped: result.stopped,
          reason: result.reason,
          turns: result.turns,
          usd: result.usage.usd,
        });
      },
    );

    return agents.functions();
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: app,
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const result = async (id: string) => {
      const thread = getThread(client, `${app}/${id}`, `${id}-${Date.now()}`, {
        kv: store,
      });

      await thread.send("go");

      const state = await ctx.eventually(
        `${id} has a result`,
        thread.state,
        (s) => {
          return s.keys.result !== undefined;
        },
      );

      return state.keys.result;
    };

    const refused = await result("sl-root");
    ctx.check(
      "a three-level chain is refused at depth 2 by default, with a readable reason",
      typeof refused === "string" &&
        refused.startsWith("REFUSED") &&
        refused.includes("sl-leaf was not started") &&
        refused.includes("limits.depth"),
      refused,
    );

    const allowed = await result("sl-root2");
    ctx.check("depth 2 allows the chain", allowed === "leaf", allowed);

    const picky = (await result("sl-picky")) as {
      denied: string;
      allowed: string;
    };
    ctx.check(
      "mayCall refuses an agent outside its list and allows one in it",
      picky.denied.startsWith("REFUSED") &&
        picky.denied.includes("limits.mayCall") &&
        picky.allowed === "leaf",
      picky,
    );

    const spender = (await result("sl-spender")) as {
      stopped: string;
      reason: string;
      turns: number;
    };
    ctx.check(
      "a spent budget stops the loop with a reason",
      spender.stopped === "budget" &&
        spender.turns === 2 &&
        spender.reason.includes("30 of 20 tokens"),
      spender,
    );

    const dollars = (await result("sl-dollars")) as {
      stopped: string;
      reason: string;
      turns: number;
      usd: number;
    };
    ctx.check(
      "a spent dollar budget stops the loop like a token budget, with the price the app gave",
      dollars.stopped === "budget" &&
        dollars.turns === 2 &&
        dollars.reason.includes("$0.000030 of $0.000020") &&
        Math.abs(dollars.usd - 0.00003) < 1e-12,
      dollars,
    );
  },
});
