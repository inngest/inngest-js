/**
 * @module
 * A reader with no step between its reads wakes for every message. Each read
 * blocks, is woken, and the next wait is written straight away, while the
 * executor may still be cleaning up the wait it just consumed. A wait that is
 * lost then leaves the run blocked for good with messages unread.
 */
import { Inngest } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

const agentId = "subscribe-timed-agent";
const ref = `agents-e2e/${agentId}`;
const messages = Number(process.env.AGENTS_E2E_MESSAGES ?? 150);

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const subscribeTimed = scenario({
  id: "subscribe-timed",
  owner: "agents-thread-key",
  needs: { oss: "jack/step-subscribe-wake" },
  capMs: 600_000,
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
      async ({ inbox }) => {
        const seen: string[] = [];

        for await (const message of inbox) {
          seen.push(message.content ?? "");

          if (seen.length === messages) {
            break;
          }
        }

        await kv.thread.set("seen", seen);
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
    const key = `fast-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));
    const seen = async () => {
      return ((await thread.state()).seen as string[] | undefined) ?? [];
    };

    const t0 = Date.now();

    const eventId = await ctx.send("msg", { thread: key, text: "m0" }, { startsRun: true });
    await sleep(2500);

    // Spaced closely, so the next wait is often written while the previous one is being cleaned up.
    for (let n = 1; n < messages; n++) {
      await thread.send(`m${n}`);
      await sleep(15);
    }

    const sentMs = Date.now() - t0;
    const all = await ctx.until(
      seen,
      (s) => {
        return s.length === messages;
      },
      540_000,
    );

    console.log(`TIMING messages=${messages} sendPhaseMs=${sentMs} totalMs=${Date.now() - t0}`);
    const outFile = process.env.AGENTS_E2E_TRACE_OUT;

    if (outFile) {
      const runs = await ctx.runsOf(eventId);
      const span = "name status queuedAt startedAt endedAt stepOp";
      const res = await fetch(`${ctx.devUrl}/v0/gql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query ($id: String!) { runTrace(runID: $id) { ${span} childrenSpans { ${span} childrenSpans { ${span} } } } }`,
          variables: { id: runs[0]?.id },
        }),
      });
      const { writeFileSync } = await import("node:fs");

      writeFileSync(outFile, JSON.stringify(await res.json()));
    }

    ctx.check(
      "every message woke the reader, once each",
      JSON.stringify([...all].sort()) ===
        JSON.stringify(
          Array.from({ length: messages }, (_, n) => {
            return `m${n}`;
          }).sort(),
        ),
      all,
    );
  },
});
