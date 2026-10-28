/**
 * @module
 * The winner of a multi-event `next()` is the same on every replay. Each round
 * sends a trigger event (stream 1) and, while its turn runs, a thread message
 * (stream 0), so by the time the turn's later steps replay the `next()` that
 * delivered the trigger, the loser's wait is in history too. A replay that
 * picked the lowest stream index would hand out the thread message first, and
 * the ack and turn steps would no longer match what ran.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inngest, step } from "inngest";
import {
  createAgents,
  createKv,
  getThread,
  kv,
  redisKvAdapter,
} from "inngest/experimental/agents";
import { scenario } from "../kit/driver.ts";
import { withKeys } from "../kit/threads.ts";

const agentId = "subscribe-replay-agent";
const ref = `agents-e2e/${agentId}`;
const rounds = 4;

// Every replay of the body appends what it saw, outside any step, so a replay
// that picked a different winner shows up here even if its steps are memoized.
const seenFile = (thread: string) => {
  return join(tmpdir(), `subscribe-replay-${thread}.log`);
};

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const list = (state: Record<string, unknown>) => {
  return (state.turns as string[] | undefined) ?? [];
};

export const subscribeReplay = scenario({
  id: "subscribe-replay",
  owner: "agents-thread-key",
  needs: { oss: "jack/step-subscribe" },
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
          // The merged position and the stream each message came from.
          appendFileSync(
            seenFile(thread.key),
            `${message.seq}:${message.source?.stream ?? "trigger"}\n`,
          );

          const where = message.source
            ? `${message.seq}:${message.source.stream}`
            : `${message.seq}:trigger`;

          await kv.thread.update<string[]>("turns", function (turns) {
            return [...(turns ?? []), `${message.data.content ?? ""}@${where}`];
          });
          // The turn takes a while, as a step: the other stream's message
          // arrives meanwhile and is in history when this `next()` replays.
          await step.run("turn-work", async () => {
            await sleep(1200);
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
    const key = `replay-${Date.now()}`;
    const thread = withKeys(getThread(client, ref, key, { kv: store }));

    await ctx.send("msg", { thread: key, text: "start" });
    await ctx.eventually("the trigger starts the thread", thread.state, (s) => {
      return list(s).length === 1;
    });

    for (let round = 1; round <= rounds; round++) {
      // Idle: the body waits on both streams.
      await sleep(1500);
      await ctx.send("msg", { thread: key, text: `e${round}` });
      await ctx.eventually(`e${round} is taken`, thread.state, (s) => {
        return list(s).length === round * 2;
      });
      await thread.send(`h${round}`);
      await ctx.eventually(`h${round} is taken`, thread.state, (s) => {
        return list(s).length === 1 + round * 2;
      });
    }

    await sleep(2000);
    const turns = list(await thread.state());
    const expected = ["start@0:trigger"];

    for (let round = 1; round <= rounds; round++) {
      expected.push(`e${round}@${round * 2 - 1}:1`, `h${round}@${round * 2}:0`);
    }

    const seen = existsSync(seenFile(key))
      ? readFileSync(seenFile(key), "utf8").trim().split("\n")
      : [];
    const streamsBySeq = new Map<string, Set<string>>();

    for (const line of seen) {
      const [seq = "", stream = ""] = line.split(":");
      streamsBySeq.set(seq, (streamsBySeq.get(seq) ?? new Set()).add(stream));
    }

    ctx.check(
      "every replay saw the same stream for each seq",
      streamsBySeq.size === rounds * 2 + 1 &&
        [...streamsBySeq.values()].every((streams) => {
          return streams.size === 1;
        }),
      { seen: [...streamsBySeq] },
    );
    ctx.check(
      "the body replayed more than once per message",
      seen.length > rounds * 4,
      seen.length,
    );

    ctx.check(
      "every message once, in arrival order, with a stable seq and stream",
      JSON.stringify(turns) === JSON.stringify(expected),
      { turns, expected },
    );
  },
});
