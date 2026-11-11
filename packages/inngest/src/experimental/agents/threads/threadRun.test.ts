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
  applyThreadWriteEvent,
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
      return event.name === "agent/thread.read";
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
        return event.name === "agent/thread.read";
      }),
    ).toEqual([]);
  });

  test("a run that starts from carried state still catches up, and in order", async () => {
    freshKv();

    const { fn, seen } = reader();

    // The state a forward carries is the whole log, including what nothing has
    // taken up - so the fast path, which does no read at all, replays exactly
    // what the read path would have handed back. The batch that woke the run
    // is itself untaken in that state, and it keeps its own order rather than
    // leading the inbox.
    await run(fn, {
      forward: false,
      event: forward(["two", "three"], {
        from: 2,
        state: held({
          seq: 3,
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
              id: "evt-2",
              name: "agent/message",
              data: { agent: ref, thread: "t1", content: "two" },
              ts: 0,
            },
            {
              seq: 3,
              id: "evt-3",
              name: "agent/message",
              data: { agent: ref, thread: "t1", content: "three" },
              ts: 0,
            },
          ],
        }),
      }),
    });

    expect(seen).toEqual(["lost", "two", "three"]);
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
      return event.name === "agent/thread.write";
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
        event.name === "agent/thread.write" &&
        (event.data as { ops?: { key?: string }[] }).ops?.some((op) => {
          return op.key === "greeting";
        }) === true
      );
    });

    expect(write).toBeDefined();
  });
});

describe("the thread run", () => {
  const made = () => {
    freshKv();

    return createAgentFunction(client(), { id: "bot" });
  };

  /**
   * What the supervisor invokes the holder with, as the holder sees it.
   */
  const holding = (over: Record<string, unknown>) => {
    return {
      name: "inngest/function.invoked",
      data: { agent: ref, thread: "t1", generation: 1, ...over },
    };
  };

  test("the supervisor triggers on the agent layer's events and the protocol's, keyed on the thread alone", () => {
    const opts = made().threadRun["opts"] as unknown as {
      singleton: { key: string; mode: string };
      triggers: { event?: string }[];
    };
    const triggers = opts.triggers.map((trigger) => {
      return trigger.event;
    });

    expect(triggers).toContain("agent/message");
    expect(triggers).toContain("agent/thread.read");
    expect(triggers).toContain("agent/thread.write");

    // Nothing a thread run sends to another thread run is a trigger.
    for (const name of threadRunSubscribedOnly) {
      expect(triggers).not.toContain(name);
    }

    expect(opts.singleton.mode).toBe("skip");

    // Keyed on the thread alone, and on the same expression the agent's own
    // singleton uses: a generation in the key would make an arrival, which
    // carries none, start a second holder.
    const agentOpts = made().fn["opts"] as unknown as {
      singleton: { key: string };
    };

    expect(opts.singleton.key).toBe(agentOpts.singleton.key);
  });

  test("the holder has no event triggers and no singleton, so nothing can skip a successor", () => {
    const opts = made().threadHolder["opts"] as unknown as {
      singleton?: unknown;
      triggers: { event?: string; cron?: string }[];
    };

    expect(opts.singleton).toBeUndefined();
    expect(opts.triggers).toHaveLength(1);
    expect(opts.triggers[0]?.event).toBe("inngest/function.invoked");
  });

  test("an arrival with no live thread starts one, which logs it and forwards it", async () => {
    const { threadHolder } = made();
    const { sent } = await run(threadHolder, {
      forward: false,
      event: holding({ start: message("hello") }),
      incoming: [
        { name: "agent/thread.done", data: { agent: ref, thread: "t1" } },
      ],
    });
    const forwards = sent.filter((event) => {
      return event.name === threadForward.name;
    });
    const first = forwards[0]?.data as {
      events?: { seq: number; name: string }[];
      state?: ThreadSnapshot;
    };

    expect(first?.events?.[0]).toMatchObject({ seq: 1, name: "agent/message" });

    // The state travels with it, so the run it starts needs no read.
    expect(first?.state?.entries).toHaveLength(1);
    expect(first?.state?.fresh).toBe(true);
  });

  test("it answers a read with what it holds, and a write is in that answer", async () => {
    const { threadHolder } = made();
    const steps: string[] = [];
    const { signals } = await run(threadHolder, {
      forward: false,
      onStep: (op) => {
        steps.push(op.userland?.id ?? op.id);
      },
      event: holding({
        start: {
          name: "agent/thread.write",
          data: {
            agent: ref,
            thread: "t1",
            id: "run-a:0",
            ops: [{ kind: "set", key: "stage", value: '"triage"' }],
          },
        },
      }),
      incoming: [
        {
          name: "agent/thread.read",
          data: {
            agent: ref,
            thread: "t1",
            signal: readSignal(ref, "t1", "reader"),
            run: "reader",
          },
        },
        { name: "agent/thread.done", data: { agent: ref, thread: "t1" } },
      ],
    });

    // The answer is computed when the read arrives and sent as a signal, so
    // it reaches the run that asked and no other.
    // The answer is computed when the read arrives and sent as a signal, so it
    // reaches the run that asked and no other.
    const answer = signals.find((sent) => {
      return sent.signal === readSignal(ref, "t1", "reader");
    });
    const held = answer?.data as ThreadSnapshot | undefined;

    expect(held?.keys.stage?.v).toBe('"triage"');
    expect(steps).toContain("read:0");
  });
});

describe("listening, which the model asks for at runtime", () => {
  test("the handler's thread.listen() asks the thread and returns once it has it", async () => {
    freshKv();

    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox, thread }) => {
        await inbox.next();

        return thread.listen("github/pull_request.review", {
          "data.number": 412,
        });
      },
    );
    const { output, sent } = await run(made.fn, {
      event: message("watch 412"),
    });
    const asked = sent.find((event) => {
      return event.name === "agent/thread.listen";
    });

    expect(output).toBe(true);
    expect(
      (asked?.data as { listen?: { event?: string; if?: string } }).listen,
    ).toEqual({
      event: "github/pull_request.review",
      if: "async.data.number == 412",
    });
  });

  test("the thread records it, acknowledges it, and re-establishes it", async () => {
    freshKv();

    const { threadHolder } = createAgentFunction(client(), { id: "bot" });
    const { signals, output } = await run(threadHolder, {
      forward: false,
      event: {
        name: "inngest/function.invoked",
        data: {
          agent: ref,
          thread: "t1",
          generation: 1,
          start: {
            name: "agent/thread.listen",
            data: {
              agent: ref,
              thread: "t1",
              listen: { event: "github/pull_request.review" },
              signal: listenSignal(ref, "t1", "reader", 0),
              run: "reader",
            },
          },
        },
      },
      incoming: [
        {
          name: "agent/thread.read",
          data: {
            agent: ref,
            thread: "t1",
            signal: readSignal(ref, "t1", "reader"),
            run: "reader",
          },
        },
        { name: "agent/thread.done", data: { agent: ref, thread: "t1" } },
      ],
    });

    expect(
      signals.find((one) => {
        return one.signal === listenSignal(ref, "t1", "reader", 0);
      })?.data,
    ).toMatchObject({ listening: true });

    // A new listen only takes effect in a new subscription, so recording one
    // hands the thread over - and the listen travels with the state, which is
    // how it outlives the run that asked for it.
    const handed = output as
      | { ended?: string; handover?: ThreadSnapshot }
      | undefined;

    expect(handed?.ended).toBe("handover");
    expect(handed?.handover?.listens).toEqual([
      { event: "github/pull_request.review" },
    ]);
  });
});

describe("the holder's reads", () => {
  test("a read is armed before the batch in hand is applied, so the busy window is covered", async () => {
    freshKv();

    const { threadHolder } = createAgentFunction(client(), { id: "bot" });
    const { ops } = await run(threadHolder, {
      forward: false,
      event: {
        name: "inngest/function.invoked",
        data: {
          agent: ref,
          thread: "t1",
          generation: 1,
          start: message("one"),
        },
      },
      incoming: [
        message("two"),
        { name: "agent/thread.done", data: { agent: ref, thread: "t1" } },
      ],
    });
    const waits = ops.filter((op) => {
      return op.op === "wait";
    });

    // No read is literally unbounded. The timeout is not a recovery
    // mechanism: an empty read says nothing has happened, and the holder reads
    // again.
    expect(waits.length).toBeGreaterThan(0);

    for (const wait of waits) {
      expect((wait.opts as { timeout?: unknown }).timeout).toBe("12h");
    }
  });
});

describe("the watermark", () => {
  test("a run a forward started hands over no arrival: the thread logged the batch itself", async () => {
    freshKv();

    const { fn } = reader();
    // No state on the forward, so the run falls back to a read - and the read
    // must not hand the forward itself over as something that arrived.
    const { sent } = await run(fn, {
      forward: false,
      event: forward(["one"]),
    });
    const read = sent.find((event) => {
      return event.name === "agent/thread.read";
    });

    expect(read).toBeDefined();
    expect((read?.data as { arrival?: unknown }).arrival).toBeUndefined();
  });

  test("a run whose only entry is the one that started it still advances it", async () => {
    freshKv();

    const { fn } = reader();
    // A cold thread: the holder logged the arrival that started it and nothing
    // has taken it up, and this run was started by that same event rather than
    // by a forward.
    const { sent } = await run(fn, {
      event: message("hi"),
      thread: held({
        seq: 1,
        taken: 0,
        entries: [
          {
            seq: 1,
            id: "evt-1",
            name: "agent/message",
            data: { agent: ref, thread: "t1", content: "hi" },
            ts: 0,
          },
        ],
      }),
    });
    const takes = sent.flatMap((event) => {
      return event.name === "agent/thread.write"
        ? ((event.data as { ops?: { kind: string; seq?: number }[] }).ops ?? [])
            .filter((op) => {
              return op.kind === "take";
            })
            .map((op) => {
              return op.seq;
            })
        : [];
    });

    // Without this the thread would hand that entry to every later run on the
    // thread, for ever, and the log would never get shorter.
    expect(takes).toContain(1);
  });
});

describe("write ids", () => {
  /**
   * The ids of the writes a run sent, in order.
   */
  const idsOf = (sent: { name: string; data?: unknown }[]) => {
    return sent.flatMap((event) => {
      return event.name === "agent/thread.write"
        ? [(event.data as { id?: string }).id]
        : [];
    });
  };

  test("two writes from one run are two writes, wherever they are made from", async () => {
    freshKv();

    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox, kv, step }) => {
        await inbox.next();

        // Between steps.
        await kv.thread.set("one", 1);

        // And from inside a step's callback, which is the path that cannot
        // issue a step of its own and sends the event directly.
        await step.run("work", async () => {
          await kv.thread.set("two", 2);
          await kv.thread.set("three", 3);

          return null;
        });

        // And between steps again, AFTER the callback. On a replay the
        // callback does not run again, so a counter the callback shares with
        // this write is one behind: this is the write that used to collide
        // with one made inside the callback, and be dropped by the thread.
        await kv.thread.set("four", 4);

        return null;
      },
    );
    const { sent } = await run(made.fn, { event: message("go") });
    const ids = idsOf(sent);

    // Every write is its own write. An id that repeats is not a duplicate
    // write: the thread keys its log on the id, so the second one is DROPPED,
    // and nothing anywhere says so.
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the thread drops a write whose id it has already applied", () => {
    const state = held();
    const write = {
      agent: ref,
      thread: "t1",
      id: "run:7",
      ops: [{ kind: "set" as const, key: "k", value: '"first"' }],
    };

    expect(applyThreadWriteEvent(state, write)).toBe(true);
    expect(
      applyThreadWriteEvent(state, {
        ...write,
        ops: [{ kind: "set" as const, key: "k", value: '"second"' }],
      }),
    ).toBe(false);
    expect(state.keys.k?.v).toBe('"first"');
  });
});
