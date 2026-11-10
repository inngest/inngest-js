/**
 * @module
 * The thread run and the agent run's side of its protocol: who holds the
 * subscriptions, what a read is answered with, what a write does, and how a
 * lost forward costs latency rather than data.
 */

import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgentFunction } from "../agent/agentFunction.ts";
import { freshKv, run } from "../agent/test-helpers.ts";
import {
  applyThreadWrite,
  emptySnapshot,
  generationKey,
  listenSignal,
  readSignal,
  type ThreadSnapshot,
  threadForward,
  threadRunSubscribedOnly,
  threadRunTriggers,
} from "./threadProtocol.ts";

const ref = `${testClientId}/bot`;

const client = () => {
  return new Inngest({ id: testClientId });
};

const message = (content: string, thread = "t1") => {
  return {
    name: "agent/message",
    data: { agent: ref, thread, content },
  };
};

const forward = (
  contents: string[],
  options: { from?: number; state?: ThreadSnapshot; thread?: string } = {},
) => {
  const from = options.from ?? 1;

  return {
    name: threadForward.name,
    data: {
      agent: ref,
      thread: options.thread ?? "t1",
      gen: 0,
      events: contents.map((content, at) => {
        return {
          seq: from + at,
          id: `evt-${from + at}`,
          name: "agent/message",
          data: { agent: ref, thread: options.thread ?? "t1", content },
          ts: 0,
        };
      }),
      ...(options.state && { state: options.state }),
    },
  };
};

const held = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => {
  return { ...emptySnapshot(), fresh: false, ...over };
};

/**
 * A reader that records each message once. The fake executor replays the run
 * several times, so a message reaches the body more than once; what each test
 * here is about is which messages reach it and in what order, not how many
 * replays the harness did.
 */
const reader = () => {
  const seen: unknown[] = [];
  const made = createAgentFunction(
    client(),
    { id: "bot" },
    async ({ inbox }) => {
      for await (const batch of inbox.batches()) {
        for (const one of batch) {
          const content = (one.data as { content?: unknown }).content;

          if (!seen.includes(content)) {
            seen.push(content);
          }
        }
      }

      return seen.length;
    },
  );

  return { seen, fn: made.fn };
};

describe("the protocol's shape", () => {
  test("no event a thread run sends to another thread run is a trigger", () => {
    // An event that a thread run sends and that triggers a thread run can
    // drive an unbounded series of runs, with a correct log and nothing in the
    // stream that looks wrong. The split is the only thing that prevents it.
    for (const name of threadRunSubscribedOnly) {
      expect(threadRunTriggers).not.toContain(name);
    }

    expect(threadRunTriggers.length).toBeGreaterThan(0);
  });

  test("a read is answered on a signal that names the run, and a listen its own", () => {
    expect(readSignal(ref, "t1", "run-1")).not.toBe(
      readSignal(ref, "t1", "run-2"),
    );
    expect(listenSignal(ref, "t1", "run-1", 0)).not.toBe(
      listenSignal(ref, "t1", "run-1", 1),
    );
    expect(generationKey("t1", 3)).toBe("t1#3");
  });

  test("a write is applied to the state, and `take` only ever moves forward", () => {
    const state = held({ seq: 5, taken: 3 });

    applyThreadWrite(state, { kind: "set", key: "k", value: '"v"' });
    expect(state.keys.k?.v).toBe('"v"');

    applyThreadWrite(state, { kind: "take", seq: 5 });
    applyThreadWrite(state, { kind: "take", seq: 2 });
    expect(state.taken).toBe(5);

    applyThreadWrite(state, { kind: "delete", key: "k" });
    expect(state.keys.k).toBeUndefined();
  });
});

describe("an agent run and its thread", () => {
  test("it holds one subscription, and its one source is the thread's forwards", async () => {
    freshKv();

    const { fn } = reader();
    const { ops } = await run(fn, { event: message("go") });
    const opens = ops.filter((op) => {
      return op.op === "open";
    });

    expect(opens).toHaveLength(1);
    expect(
      (opens[0]?.opts as { sources: { event: string }[] }).sources.map((s) => {
        return s.event;
      }),
    ).toEqual([threadForward.name]);
  });

  test("it obtains state with the request for it, in one request", async () => {
    freshKv();

    const { fn } = reader();
    const { sent } = await run(fn, { event: message("go") });
    const read = sent.find((event) => {
      return event.name === "agent/thread-run.read";
    });

    expect(read).toBeDefined();
    expect((read?.data as { signal?: string }).signal).toBe(
      readSignal(ref, "t1", "run"),
    );
    // The event that started the run travels with the read, so the thread's
    // log holds it even when the thread never saw it.
    expect((read?.data as { arrival?: { name?: string } }).arrival?.name).toBe(
      "agent/message",
    );
  });

  test("a forward that carries the thread's state costs no read at all", async () => {
    freshKv();

    const { fn, seen } = reader();
    const { sent } = await run(fn, {
      event: forward(["go"], { state: held({ seq: 1, taken: 1 }) }),
    });

    expect(seen).toEqual(["go"]);
    expect(
      sent.filter((event) => {
        return event.name === "agent/thread-run.read";
      }),
    ).toEqual([]);
  });

  test("a batch forwarded as one event becomes one turn's messages", async () => {
    freshKv();

    const { fn, seen } = reader();

    await run(fn, { event: forward(["one", "two", "three"]) });

    expect(seen).toEqual(["one", "two", "three"]);
  });

  test("entries the thread holds and nothing took up lead the inbox: a lost forward is late, not wrong", async () => {
    freshKv();

    const { fn, seen } = reader();

    // The thread holds two entries and no run has taken either: the forward
    // that carried the first was lost at the skip boundary.
    await run(fn, {
      event: message("newest"),
      thread: held({
        seq: 2,
        taken: 0,
        entries: [
          {
            seq: 1,
            id: "evt-lost",
            name: "agent/message",
            data: { agent: ref, thread: "t1", content: "lost" },
            ts: 0,
          },
          {
            seq: 2,
            id: "evt-also-lost",
            name: "agent/message",
            data: { agent: ref, thread: "t1", content: "also lost" },
            ts: 0,
          },
        ],
      }),
    });

    expect(seen.slice(0, 3)).toEqual(["lost", "also lost", "newest"]);
  });

  test("it tells the thread how far it read, with a write id derived from the run", async () => {
    freshKv();

    const { fn } = reader();
    const { sent } = await run(fn, { event: forward(["one", "two"]) });
    const writes = sent.filter((event) => {
      return event.name === "agent/thread-run.write";
    });
    const took = writes.find((event) => {
      return (
        (event.data as { ops?: { kind: string }[] }).ops?.some((op) => {
          return op.kind === "take";
        }) === true
      );
    });

    expect(
      (took?.data as { ops: { kind: string; seq?: number }[] }).ops.at(-1),
    ).toEqual({ kind: "take", seq: 2 });

    // Every write names itself, and the id is the run and a count of its
    // writes: a replay derives the same one, and the thread keys its log on it.
    for (const write of writes) {
      expect((write.data as { id?: string }).id).toMatch(/^run:\d+$/);
    }
  });
});

describe("kv.thread, which is sugar", () => {
  test("a get reads what the run already holds, and costs no step", async () => {
    freshKv();

    const seen: unknown[] = [];
    const { fn } = (() => {
      const made = createAgentFunction(
        client(),
        { id: "bot" },
        async ({ inbox, kv }) => {
          await inbox.next();

          const got = await kv.thread.get("greeting");

          if (!seen.includes(got)) {
            seen.push(got);
          }

          return null;
        },
      );

      return { fn: made.fn };
    })();

    const { ops } = await run(fn, {
      event: message("go"),
      thread: held({ keys: { greeting: { v: '"hello"' } } }),
    });

    expect(seen).toEqual(["hello"]);
    expect(
      ops.filter((op) => {
        return op.id.startsWith("kv.");
      }),
    ).toEqual([]);
  });

  test("a set sends the thread one write", async () => {
    freshKv();

    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox, kv }) => {
        await inbox.next();
        await kv.thread.set("greeting", "hello");

        return (await kv.thread.get("greeting")) as string;
      },
    );
    const { output, sent } = await run(made.fn, { event: message("go") });

    // The write is in the run's own view at once: a get is local.
    expect(output).toBe("hello");

    const write = sent.find((event) => {
      return (
        event.name === "agent/thread-run.write" &&
        (event.data as { ops?: { key?: string }[] }).ops?.some((op) => {
          return op.key === "greeting";
        }) === true
      );
    });

    expect(write).toBeDefined();
  });
});
