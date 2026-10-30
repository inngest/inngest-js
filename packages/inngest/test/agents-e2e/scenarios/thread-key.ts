/**
 * @module
 * A thread key from the trigger, as an expression the backend reads. Trigger
 * events for the same thread start one run and reach it as messages, mixed
 * with messages sent through the thread handle, none lost and none repeated;
 * another thread starts its own run; a stop now cancels the run an event
 * started and the next event starts a new one.
 */
import { Inngest } from "inngest";
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

const agentId = "thread-key-agent";
const ref = `agents-e2e/${agentId}`;
const numericId = "thread-key-numeric-agent";
const numericRef = `agents-e2e/${numericId}`;
const stopId = "thread-key-stop-agent";
const stopRef = `agents-e2e/${stopId}`;

const list = (state: Record<string, unknown>, key: string) => {
  return (state[key] as string[] | undefined) ?? [];
};

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const threadKey = scenario({
  id: "thread-key",
  owner: "agents-thread-key",
  needs: { oss: "jack/step-subscribe-wake" },
  functions: ({ client, event }) => {
    const agents = createAgents(client);
    const bot = agents.agent(
      {
        id: agentId,
        on: {
          event: event("msg"),
          thread:
            'event.data.channel + "/" + (has(event.data.thread_ts) ? event.data.thread_ts : event.data.ts)',
        },
      },
      async ({ inbox }) => {
        await kv.thread.update(kvKey<number>("runs"), function (runs) {
          return (runs ?? 0) + 1;
        });

        for await (const message of inbox) {
          await kv.thread.update(kvKey<string[]>("turns"), function (turns) {
            return [...(turns ?? []), textOf(message) ?? ""];
          });
          await sleep(150);
        }
      },
    );

    // A key built from numbers. The backend reads JSON numbers as doubles and
    // writes them with Go's shortest %g, so string() of 1234567 is
    // "1.234567e+06", and string(int()) of an id is the whole number. The SDK
    // computes the same key; the second event reaching the live run proves the
    // backend's inbox filter agrees.
    agents.agent(
      {
        id: numericId,
        on: {
          event: event("num"),
          thread:
            '"n" + string(event.data.big) + "#" + string(int(event.data.id))',
        },
      },
      async ({ inbox }) => {
        await kv.thread.update(kvKey<number>("runs"), function (runs) {
          return (runs ?? 0) + 1;
        });

        for await (const message of inbox) {
          await kv.thread.update(kvKey<string[]>("turns"), function (turns) {
            return [
              ...(turns ?? []),
              String((message.data as { n?: number }).n),
            ];
          });
        }
      },
    );

    const stoppable = agents.agent(
      {
        id: stopId,
        on: { event: event("stop-msg"), thread: 'event.data.key + "/s"' },
      },
      async ({ inbox }) => {
        await kv.thread.update(kvKey<number>("runs"), function (runs) {
          return (runs ?? 0) + 1;
        });

        for await (const message of inbox) {
          await kv.thread.update(kvKey<string[]>("turns"), function (turns) {
            return [...(turns ?? []), message.name ?? ""];
          });
          await sleep(60_000);
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
    const channel = `C${Date.now()}`;
    const handle = (key: string) => {
      return withKeys(getThread(client, ref, key, { kv: store }));
    };
    const t1 = handle(`${channel}/1.0`);
    const t2 = handle(`${channel}/2.0`);

    // Two trigger events for one thread: one run, the second delivered.
    await ctx.send("msg", { channel, thread_ts: "1.0", text: "first" });
    await ctx.eventually("first message starts the thread", t1.state, (s) => {
      return list(s, "turns").includes("first");
    });
    await ctx.send("msg", {
      channel,
      ts: "9.9",
      thread_ts: "1.0",
      text: "second",
    });
    await ctx.eventually(
      "second trigger is delivered to the live run",
      t1.state,
      (s) => {
        return list(s, "turns").includes("second");
      },
    );

    // Trigger events and handle messages interleaved, while turns are busy. Order across (and within a burst of) events is arrival order at the executor, so only the set is checked.
    const sent = {
      event: ["e1", "e2", "e3", "e4"],
      handle: ["h1", "h2", "h3", "h4"],
    };
    for (let i = 0; i < 4; i++) {
      await ctx.send("msg", {
        channel,
        ts: `9.${i}`,
        thread_ts: "1.0",
        text: sent.event[i],
      });
      await (i % 2 === 0
        ? t1.send(sent.handle[i] as string)
        : t1.steer(sent.handle[i] as string));
    }

    const state = await ctx.until(
      t1.state,
      (s) => {
        return list(s, "turns").length >= 10;
      },
      40_000,
    );
    await sleep(2000);
    const settled = await t1.state();
    const turns = list(settled, "turns");

    ctx.check("still one run for the thread", settled.runs === 1, settled);
    ctx.check(
      "every message is one turn: none lost, none repeated",
      JSON.stringify([...turns].sort()) ===
        JSON.stringify(
          ["first", "second", ...sent.event, ...sent.handle].sort(),
        ),
      { state, turns },
    );
    // A key built with string() and string(int()).
    const numeric = withKeys(
      getThread(client, numericRef, "n1.234567e+06#9876543210", { kv: store }),
    );
    await ctx.send("num", { big: 1234567, id: 9876543210, n: 1 });
    await ctx.eventually(
      "a key with string() starts its thread",
      numeric.state,
      (s) => {
        return list(s, "turns").includes("1");
      },
    );
    await ctx.send("num", { big: 1234567, id: 9876543210, n: 2 });
    const numbers = await ctx.eventually(
      "the second event with the same numbers reaches the live run",
      numeric.state,
      (s) => {
        return list(s, "turns").includes("2");
      },
    );
    ctx.check("one run for the numeric key", numbers.runs === 1, numbers);

    // Another thread starts its own run.
    await ctx.send("msg", { channel, ts: "2.0", text: "other" });
    const other = await ctx.eventually(
      "another thread starts its own run",
      t2.state,
      (s) => {
        return list(s, "turns").includes("other");
      },
    );
    ctx.check("the other thread has its own run", other.runs === 1, other);

    // A stop now cancels the run an event started, by its run ID, even though
    // the thread key is computed (a path joined with a suffix); the next event
    // starts a new run.
    const s1 = withKeys(
      getThread(client, stopRef, `${channel}-stop/s`, { kv: store }),
    );
    await ctx.send("stop-msg", { key: `${channel}-stop` });
    await ctx.eventually("a path key starts its thread", s1.state, (s) => {
      return list(s, "turns").length === 1;
    });
    const s1Handle = getThread(client, stopRef, `${channel}-stop/s`, {
      kv: store,
    });
    const s1Stop = await s1.stop({ when: "now" });
    ctx.check("stop now found the live run", s1Stop.stopped === true, s1Stop);

    // The cancelled run is cleaned up before the next event: otherwise the
    // event would reach it as a message instead of starting a new run.
    await ctx.until(
      async () => {
        return (await s1Handle.state()).status;
      },
      (status) => {
        return status === "idle";
      },
      60_000,
    );
    await ctx.send("stop-msg", { key: `${channel}-stop` });
    const after = await ctx.eventually(
      "an event after a stop now starts a new run",
      s1.state,
      (s) => {
        return s.runs === 2;
      },
    );
    ctx.check("two runs, two turns", list(after, "turns").length === 2, after);
  },
});
