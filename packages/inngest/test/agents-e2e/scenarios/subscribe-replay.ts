/**
 * @module
 * Messages of a multi-event subscription keep their order across replays. Each
 * round sends a trigger event and, while its turn runs, a thread message (two
 * events of one subscription), so by the time the turn's later steps replay the
 * `next()` that delivered the trigger, the second message is in the run's state
 * too. The order is the run's stack, so every replay must hand out the same
 * message at the same position; one that did not would run steps that no longer
 * match the ones that ran.
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
import { textOf } from "../kit/text.ts";
import { withKeys } from "../kit/threads.ts";

const agentId = "subscribe-replay-agent";
const ref = `agents-e2e/${agentId}`;
const rounds = 4;

// Every replay of the body appends what it saw, outside any step, so a replay
// that picked a different winner shows up here even if its steps are memoized.
// The worker and the CLI share a machine, so they share this file.
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
  needs: { oss: "jack/step-subscribe-clean" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);

    agents.agent(
      {
        id: agentId,
        on: {
          event: event("msg"),
          thread: "event.data.thread",
        },
      },
      async ({ inbox, thread }) => {
        for await (const message of inbox) {
          // The position and the event of each message, as every replay sees it.
          appendFileSync(
            seenFile(thread.key),
            `${message.seq}:${textOf(message)}\n`,
          );

          const where = message.seq;

          await kv.thread.update(kvKey<string[]>("turns"), function (turns) {
            return [...(turns ?? []), `${textOf(message) ?? ""}@${where}`];
          });
          // The turn takes a while, as a step: the other stream's message
          // arrives meanwhile and is in history when this `next()` replays.
          await step.run("turn-work", async () => {
            await sleep(3000);
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
    const expected = ["start@0"];

    for (let round = 1; round <= rounds; round++) {
      expected.push(`e${round}@${round * 2 - 1}`, `h${round}@${round * 2}`);
    }

    const seen = existsSync(seenFile(key))
      ? readFileSync(seenFile(key), "utf8").trim().split("\n")
      : [];
    const streamsBySeq = new Map<string, Set<string>>();

    for (const line of seen) {
      const [seq = "", content = ""] = line.split(":");
      streamsBySeq.set(seq, (streamsBySeq.get(seq) ?? new Set()).add(content));
    }

    ctx.check(
      "every replay saw the same message at each seq",
      streamsBySeq.size === rounds * 2 + 1 &&
        [...streamsBySeq.values()].every((streams) => {
          return streams.size === 1;
        }),
      { seen: [...streamsBySeq] },
    );
    ctx.check(
      "the body replayed every message but the last at least once more",
      [...streamsBySeq.keys()]
        .filter((seq) => {
          return Number(seq) < rounds * 2;
        })
        .every((seq) => {
          return (
            seen.filter((line) => {
              return line.startsWith(`${seq}:`);
            }).length >= 2
          );
        }),
      Object.fromEntries(
        [...streamsBySeq.keys()].map((seq) => {
          return [
            seq,
            seen.filter((line) => {
              return line.startsWith(`${seq}:`);
            }).length,
          ];
        }),
      ),
    );

    if (existsSync(seenFile(key))) {
      unlinkSync(seenFile(key));
    }

    ctx.check(
      "every message once, in arrival order, with a stable seq",
      JSON.stringify(turns) === JSON.stringify(expected),
      { turns, expected },
    );
  },
});
