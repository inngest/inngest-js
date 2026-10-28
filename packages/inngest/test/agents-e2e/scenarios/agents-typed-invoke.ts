/**
 * @module
 * An agent with an `invoke()` trigger, called with `agent.invoke(agent, input)`:
 * the input is typed from the trigger's schema, the body's return is the
 * result, and the callee runs on the thread `agent.invoke()` names. A stop
 * now on that thread cancels the run the invoke started.
 */
import { Inngest, invoke } from "inngest";
import {
  agent,
  createAgents,
  createKv,
  getThread,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario } from "../kit/driver.ts";

export const agentsTypedInvoke = scenario({
  id: "agents-typed-invoke",
  owner: "agents-event-types",
  needs: { oss: "jack/step-subscribe" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);
    const asked = invoke(z.object({ question: z.string() }));

    const researcher = agents.agent(
      { id: "typed-researcher", on: asked },
      async ({ event: started, thread }) => {
        return {
          answer: `about ${started.data.event?.data.question}`,
          thread: thread.key,
        };
      },
    );

    const waiter = agents.agent(
      { id: "typed-waiter", on: invoke(z.object({ n: z.number() })) },
      async ({ inbox }) => {
        for await (const _message of inbox) {
          // waits for messages that never come
        }
      },
    );

    return [
      ...agents.functions(),
      client.createFunction(
        { id: "typed-stop-caller", triggers: [{ event: event("stop-go") }] },
        async () => {
          try {
            await agent.invoke(
              waiter,
              { n: 1 },
              { thread: "typed-stop-thread" },
            );

            return { ended: true };
          } catch {
            return { ended: true };
          }
        },
      ),
      client.createFunction(
        { id: "typed-invoke-caller", triggers: [{ event: event("go") }] },
        async () => {
          const result = await agent.invoke(researcher, { question: "why" });

          return result;
        },
      ),
    ];
  },
  run: async (ctx) => {
    const store = createKv({ adapter: redisKvAdapter(ctx.redisUrl) });
    const client = new Inngest({
      id: "agents-e2e",
      baseUrl: ctx.devUrl,
      isDev: true,
    });
    const run = await ctx.finished(await ctx.send("go"));

    ctx.expect.run(run).toComplete();
    const out = run.output as { answer?: string; thread?: string };

    ctx.check(
      "the result is what the body returned",
      out?.answer === "about why",
      out,
    );
    ctx.check(
      "the callee runs on the thread agent.invoke() named",
      /^typed-researcher:.+\.0$/.test(out?.thread ?? ""),
      out,
    );

    const caller = await ctx.send("stop-go");
    const waiting = getThread(
      client,
      "agents-e2e/typed-waiter",
      "typed-stop-thread",
      { kv: store },
    );

    await ctx.eventually(
      "the invoked agent waits for messages",
      waiting.state,
      (s) => {
        return s.status === "waiting";
      },
    );
    await waiting.stop({ when: "now" });

    // The executor completes the caller's run itself when the invoked run is
    // cancelled (null output, nothing after the invoke runs), as it does for
    // any cancelled step.invoke target.

    const ended = await ctx.finished(caller);

    ctx.expect.run(ended).toComplete();
    await ctx.eventually(
      "a stop now ends the run the invoke started",
      waiting.state,
      (s) => {
        return s.status !== "waiting";
      },
    );
  },
});
