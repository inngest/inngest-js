/**
 * @module
 * `agent.invoke("appId/functionId", data)`: a function starts a second by a
 * plain string and gets its output, and that one starts a third. The invoked
 * functions have no trigger, keep the first run's session, run on threads of
 * their own and know their depth.
 */

import {
  agent,
  agentInvokeDepth,
  agentInvokeInput,
} from "inngest/experimental";
import { scenario } from "../kit/driver.ts";

/**
 * What each function in the chain returns about itself.
 */
interface Seen {
  answer: string;
  session?: string;
  thread?: string;
  depth: number;
  inner?: Seen;
}

export const agentInvoke = scenario({
  id: "agent-invoke",
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "invoke-parent", triggers: [{ event: event("go") }] },
        async ({ runId }) => {
          const child = await agent.invoke<Seen>("agents-e2e/invoke-child", {
            question: "why",
          });

          return { runId, child };
        },
      ),
      client.createFunction(
        { id: "invoke-child", triggers: [] },
        async ({ event: trigger, sessions }) => {
          const input = agentInvokeInput(trigger) as { question: string };
          const inner = await agent.invoke<Seen>("agents-e2e/invoke-leaf", {
            question: input.question,
          });

          return {
            answer: `because: ${input.question}`,
            session: sessions?.agent_session,
            thread: sessions?.agent_thread,
            depth: agentInvokeDepth(trigger),
            inner,
          };
        },
      ),
      client.createFunction(
        { id: "invoke-leaf", triggers: [] },
        async ({ event: trigger, sessions }) => {
          return {
            answer: "leaf",
            session: sessions?.agent_session,
            thread: sessions?.agent_thread,
            depth: agentInvokeDepth(trigger),
          };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(await ctx.send("go"));
    const out = run.output as { runId: string; child: Seen };
    const child = out?.child;
    const leaf = child?.inner;

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toHaveSteps("agent:invoke:agents-e2e/invoke-child");
    ctx.check(
      "the child returned its output",
      child?.answer === "because: why" && leaf?.answer === "leaf",
      JSON.stringify(out),
    );
    ctx.check(
      "both keep the first run's session",
      child?.session === out?.runId && leaf?.session === out?.runId,
      JSON.stringify(out),
    );
    ctx.check(
      "each gets a thread of its own",
      child?.thread === `invoke-child:${out?.runId}.0` &&
        leaf?.thread?.startsWith("invoke-leaf:") === true &&
        leaf.thread !== child?.thread,
      JSON.stringify(out),
    );
    ctx.check(
      "depth counts the chain",
      child?.depth === 1 && leaf?.depth === 2,
      JSON.stringify(out),
    );
  },
});
