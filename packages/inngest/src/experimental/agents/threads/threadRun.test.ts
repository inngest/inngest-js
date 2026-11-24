/**
 * @module
 * The thread run and the agent run's side of its protocol: who holds the
 * subscriptions, what a read is answered with, what a write does, and how a
 * lost forward costs latency rather than data.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgentFunction } from "../agent/agentFunction.ts";
import { trackChild } from "../agent/children.ts";
import { freshKv, run } from "../agent/test-helpers.ts";
import { kv as internalKv } from "../kv/kv.ts";
import {
  applyThreadWrite,
  applyThreadWriteEvent,
  emptySnapshot,
  generationKey,
  listenSignal,
  readSignal,
  startReadSignal,
  type ThreadSnapshot,
  type ThreadWriteData,
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
    // A forward with no state on it: the thread was too big to travel, so the
    // run asks.
    const { sent } = await run(fn, { forward: false, event: forward(["go"]) });
    const read = sent.find((event) => {
      return event.name === "agent/thread.read";
    });

    expect(read).toBeDefined();
    expect((read?.data as { signal?: string }).signal).toBe(
      readSignal(ref, "t1", "run"),
    );
  });

  test("a message starts it as its thread's forward, which costs no read", async () => {
    freshKv();

    const { fn, seen } = reader();
    const { sent } = await run(fn, { event: message("go") });

    expect(seen).toEqual(["go"]);
    expect(
      sent.filter((event) => {
        return event.name === "agent/thread.read";
      }),
    ).toEqual([]);
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

    // Every write names itself. A change is named by the run and a count of
    // its writes; a CONFIRMATION is named by the position it confirms, because
    // it is a fact rather than a change and is issued from a place that does
    // not re-execute.
    for (const write of writes) {
      const id = String((write.data as { id?: string }).id);
      const ops = (write.data as { ops?: { kind: string }[] }).ops ?? [];
      const factual = ops.every((op) => {
        return op.kind === "take";
      });

      expect(id).toMatch(factual ? /^run:take:\d+$/ : /^run:\d+$/);
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

  test("the thread records it, hands over, and leaves the acknowledgement to the next run", async () => {
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

    // A new listen only takes effect in a new subscription, so recording one
    // hands the thread over - and the listen travels with the state, which is
    // how it outlives the run that asked for it.
    const handed = output as
      | {
          ended?: string;
          handover?: ThreadSnapshot;
          owed?: { signal: string; data: unknown }[];
        }
      | undefined;

    // This run does not acknowledge it. Nothing is subscribed between this
    // run ending and the next one subscribing, so an asker told "recorded"
    // now would send its next write into that gap. The acknowledgement is
    // handed to the next run instead.
    expect(signals).toEqual([]);
    expect(handed?.owed).toEqual([
      {
        signal: listenSignal(ref, "t1", "reader", 0),
        data: { listening: true, event: "github/pull_request.review" },
      },
    ]);

    expect(handed?.ended).toBe("handover");
    expect(handed?.handover?.listens).toEqual([
      { event: "github/pull_request.review" },
    ]);
  });
});

describe("what the thread does with a listen", () => {
  /**
   * Runs one generation of the thread run, started by `first`, with `more`
   * arriving after it and a `done` at the end. Gives back what the thread
   * handed over and the signals it sent.
   */
  const heldAfter = async (
    first: Record<string, unknown>,
    more: Record<string, unknown>[] = [],
    carried?: ThreadSnapshot,
  ) => {
    freshKv();

    const { threadHolder } = createAgentFunction(client(), { id: "bot" });
    const asListen = (data: Record<string, unknown>, nth: number) => {
      return {
        name: "agent/thread.listen",
        data: {
          agent: ref,
          thread: "t1",
          signal: listenSignal(ref, "t1", "reader", nth),
          run: "reader",
          ...data,
        },
      };
    };
    const { signals, output, ops } = await run(threadHolder, {
      forward: false,
      event: {
        name: "inngest/function.invoked",
        data: {
          agent: ref,
          thread: "t1",
          generation: 1,
          start: asListen(first, 0),
          ...(carried && { carried }),
        },
      },
      incoming: [
        ...more.map((data, at) => {
          return asListen(data, at + 1);
        }),
        { name: "agent/thread.done", data: { agent: ref, thread: "t1" } },
      ],
    });
    const handed = output as
      | {
          ended?: string;
          handover?: ThreadSnapshot;
          owed?: { signal: string; data: { listening?: boolean } }[];
        }
      | undefined;

    // What the asker is told, whichever generation tells it: this one, or the
    // next one for a listen that made this one hand over.
    const heard = (nth: number) => {
      const signal = listenSignal(ref, "t1", "reader", nth);

      return [...signals, ...(handed?.owed ?? [])].find((one) => {
        return one.signal === signal;
      })?.data as { listening?: boolean } | undefined;
    };
    const told = signals.map((one) => {
      return one.signal;
    });
    const sources = ops.flatMap((op) => {
      return (
        (op.opts as { sources?: { event: string; if?: string }[] })?.sources ??
        []
      );
    });

    return { handed, heard, sources, told };
  };

  test.each([
    ["agent/thread.write"],
    ["agent/thread.forward"],
    ["inngest/function.finished"],
    ["billing/*"],
  ])("a reserved name is refused and the asker is told: %s", async (event) => {
    const { handed, heard } = await heldAfter({ listen: { event } });

    expect(heard(0)).toMatchObject({ listening: false });
    expect(handed?.handover?.listens ?? []).toEqual([]);
  });

  test("a listen that changes nothing is acknowledged at once: there is no handover to wait for", async () => {
    const carried: ThreadSnapshot = {
      ...emptySnapshot(),
      listens: [{ event: "billing/invoice.paid" }],
    };
    const { handed, told } = await heldAfter(
      { listen: { event: "billing/invoice.paid" } },
      [],
      carried,
    );

    expect(told).toEqual([listenSignal(ref, "t1", "reader", 0)]);
    expect(handed?.owed).toBeUndefined();
    expect(handed?.ended).toBe("done");
  });

  test("the next run acknowledges what it was handed, after it has subscribed", async () => {
    freshKv();

    const { threadHolder } = createAgentFunction(client(), { id: "bot" });
    const owed = {
      signal: listenSignal(ref, "t1", "reader", 0),
      data: { listening: true, event: "billing/invoice.paid" },
    };
    const order: string[] = [];
    const { signals } = await run(threadHolder, {
      forward: false,
      event: {
        name: "inngest/function.invoked",
        data: {
          agent: ref,
          thread: "t1",
          generation: 2,
          carried: {
            ...emptySnapshot(),
            listens: [{ event: "billing/invoice.paid" }],
          },
          owed: [owed],
        },
      },
      onOp: (op) => {
        order.push(String(op.op));
      },
      incoming: [
        { name: "agent/thread.done", data: { agent: ref, thread: "t1" } },
      ],
    });

    expect(signals).toMatchObject([owed]);
    expect(signals).toHaveLength(1);
    // The subscription is the first thing the run does.
    expect(order[0]).toBe("Subscribe");
  });

  test("a listen carries how far its run has read, so that outlives the handover", async () => {
    const carried: ThreadSnapshot = { ...emptySnapshot(), seq: 3, taken: 1 };
    const { handed } = await heldAfter(
      { listen: { event: "billing/invoice.paid" }, taken: 3 },
      [],
      carried,
    );

    expect(handed?.ended).toBe("handover");
    expect(handed?.handover?.taken).toBe(3);
  });

  test("the same request with a new scope replaces the old one", async () => {
    const carried: ThreadSnapshot = {
      ...emptySnapshot(),
      listens: [
        {
          event: "billing/invoice.paid",
          if: 'async.data.org == "acme" && async.data.invoice == "inv_9"',
          where: 'async.data.invoice == "inv_9"',
        },
      ],
    };
    const next = {
      event: "billing/invoice.paid",
      if: 'async.data.org == "globex" && async.data.invoice == "inv_9"',
      where: 'async.data.invoice == "inv_9"',
    };
    const { handed, heard } = await heldAfter({ listen: next }, [], carried);

    expect(heard(0)).toMatchObject({ listening: true });
    expect(handed?.handover?.listens).toEqual([next]);
  });

  test("a drop finds the watch by its event and the model's where, whatever its scope", async () => {
    const carried: ThreadSnapshot = {
      ...emptySnapshot(),
      listens: [
        {
          event: "billing/invoice.paid",
          if: 'async.data.org == "acme" && async.data.invoice == "inv_9"',
          where: 'async.data.invoice == "inv_9"',
        },
        {
          event: "billing/invoice.paid",
          if: 'async.data.org == "acme"',
          where: "",
        },
      ],
    };
    const { handed } = await heldAfter(
      {
        remove: true,
        listen: {
          event: "billing/invoice.paid",
          if: 'async.data.invoice == "inv_9"',
          where: 'async.data.invoice == "inv_9"',
        },
      },
      [],
      carried,
    );

    expect(handed?.handover?.listens).toEqual([
      {
        event: "billing/invoice.paid",
        if: 'async.data.org == "acme"',
        where: "",
      },
    ]);
  });

  test("a drop from the model also finds a watch recorded with no where", async () => {
    const carried: ThreadSnapshot = {
      ...emptySnapshot(),
      listens: [
        {
          event: "app/user.message",
        },
        {
          event: "ci/status",
          if: 'async.data.state == "red"',
        },
      ],
    };
    const { handed } = await heldAfter(
      {
        remove: true,
        listen: {
          event: "ci/status",
          if: 'async.data.state == "red"',
          where: 'async.data.state == "red"',
        },
      },
      [],
      carried,
    );

    expect(handed?.handover?.listens).toEqual([{ event: "app/user.message" }]);
  });

  test("a reserved name the thread already has is not subscribed to again", async () => {
    const carried: ThreadSnapshot = {
      ...emptySnapshot(),
      listens: [
        {
          event: "agent/thread.forward",
        },
        {
          event: "ci/status",
          if: 'async.data.state == "red"',
        },
      ],
    };
    const { sources } = await heldAfter(
      { listen: { event: "deploy/done" } },
      [],
      carried,
    );

    expect(
      sources.filter((source) => {
        return source.event === "agent/thread.forward";
      }),
    ).toEqual([]);
    expect(sources).toContainEqual({
      event: "ci/status",
      if: 'async.data.state == "red"',
    });
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

    // No read is unbounded: the timeout is how long a thread may sit idle.
    expect(waits.length).toBeGreaterThan(0);

    for (const wait of waits) {
      expect((wait.opts as { timeout?: unknown }).timeout).toBe("12h");
    }
  });
});

describe("a thread nothing arrives for", () => {
  test("ends, as a done does, when a read comes back empty", async () => {
    freshKv();

    const { threadHolder } = createAgentFunction(client(), { id: "bot" });
    const { output } = await run(threadHolder, {
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
      timeouts: 1,
    });
    const ended = output as
      | { ended?: string; handover?: ThreadSnapshot }
      | undefined;

    // Done and not a handover: nothing carries the state on, so the next
    // arrival starts an empty thread.
    expect(ended?.ended).toBe("done");
    expect(ended?.handover).toBeUndefined();
  });
});

describe("a thread a cron tick started", () => {
  // A cron tick starts an agent run of its own as well as the thread: the
  // thread does not subscribe to it, so it cannot be forwarded to a live run.
  const tick = {
    id: "evt-1",
    name: "inngest/scheduled.timer",
    data: { cron: "0 * * * *" },
  };
  const nightly = () => {
    return createAgentFunction(
      client(),
      { id: "bot", triggers: { cron: "0 * * * *" } },
      async () => {
        return null;
      },
    );
  };

  test("sends its state to the run the same tick started, unasked", async () => {
    freshKv();

    const { threadHolder } = nightly();
    const { signals } = await run(threadHolder, {
      forward: false,
      event: {
        name: "inngest/function.invoked",
        data: { agent: ref, thread: "bot", generation: 1, start: tick },
      },
      timeouts: 1,
    });
    const pushed = signals.find((sent) => {
      return sent.signal === startReadSignal(ref, "bot", "evt-1");
    });

    // The run that reads may have asked before this run subscribed, and that
    // read reached nothing. The state it would have been answered with is the
    // log holding the event that started both.
    expect(pushed).toBeDefined();
    expect((pushed?.data as ThreadSnapshot).entries).toHaveLength(1);
  });

  test("sends nothing unasked for a message: its forward carries the state", async () => {
    freshKv();

    const { threadHolder } = nightly();
    const { signals, sent } = await run(threadHolder, {
      forward: false,
      event: {
        name: "inngest/function.invoked",
        data: {
          agent: ref,
          thread: "t1",
          generation: 1,
          start: { ...message("one"), id: "evt-1" },
        },
      },
      timeouts: 1,
    });

    expect(signals).toEqual([]);
    expect(
      (
        sent.find((event) => {
          return event.name === threadForward.name;
        })?.data as { state?: ThreadSnapshot }
      ).state?.entries,
    ).toHaveLength(1);
  });

  test("sends nothing unasked when a read started it: that read is answered", async () => {
    freshKv();

    const { threadHolder } = nightly();
    const { signals } = await run(threadHolder, {
      forward: false,
      event: {
        name: "inngest/function.invoked",
        data: {
          agent: ref,
          thread: "t1",
          generation: 1,
          start: {
            id: "evt-2",
            name: "agent/thread.read",
            data: { agent: ref, thread: "t1", signal: "asked", run: "r1" },
          },
        },
      },
      timeouts: 1,
    });

    expect(
      signals.map((sent) => {
        return sent.signal;
      }),
    ).toEqual(["asked"]);
  });

  test("the run it started waits on a signal named by that tick", async () => {
    freshKv();

    const { fn } = nightly();
    const { sent } = await run(fn, { forward: false, event: tick });
    const read = sent.find((event) => {
      return event.name === "agent/thread.read";
    });

    expect((read?.data as { signal?: string }).signal).toBe(
      startReadSignal(ref, "bot", "evt-1"),
    );
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
    // has taken it up, and its forward of that entry started this run.
    const { sent } = await run(fn, {
      event: { ...message("hi"), id: "evt-1" },
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

        // Between steps, which is the only place a user's code may write.
        await kv.thread.set("one", 1);

        // And from inside a step's callback, as the SDK's own writers do: that
        // path cannot issue a step of its own, so it sends the event directly.
        await step.run("work", async () => {
          await internalKv.thread.set("two", 2);
          await internalKv.thread.set("three", 3);

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

  test("a step whose name holds a colon cannot be mistaken for another step's write", async () => {
    freshKv();

    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox, step }) => {
        await inbox.next();

        // A step named like the start of another step's write id. Unescaped,
        // `<run>:work:0:0` and `<run>:work:0` read the same way round.
        await step.run("work:0", async () => {
          await internalKv.thread.set("one", 1);

          return null;
        });
        await step.run("work", async () => {
          await internalKv.thread.set("two", 2);

          return null;
        });

        return null;
      },
    );
    const { sent } = await run(made.fn, { event: message("go") });
    const ids = idsOf(sent);

    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a user's write inside a step's callback throws, and says what to do instead", async () => {
    freshKv();

    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox, kv, step }) => {
        await inbox.next();

        try {
          await step.run("work", async () => {
            await kv.thread.set("held", true);

            return null;
          });
        } catch (error) {
          return (error as Error).message;
        }

        return "it did not throw";
      },
    );
    const { output } = await run(made.fn, { event: message("go") });
    const said = String(output);

    // It would be durable and the run could not read it back, which is a
    // surprise rather than an obvious mistake: so it fails on the first
    // attempt, and says why and what to do.
    expect(said).toContain("cannot be called inside a step's callback");
    expect(said).toContain("could not read it back");
    expect(said).toContain("Return the value from the step");
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

describe("an entry is delivered to one run and not again", () => {
  /**
   * What the thread holds after a run, from the writes it sent. This is the
   * property none of the five demonstrations covers: they count answers and
   * history, not whether an entry comes back.
   */
  const after = (
    state: ThreadSnapshot,
    sent: { name: string; data?: unknown }[],
  ) => {
    const held = structuredClone(state);

    for (const event of sent) {
      if (event.name === "agent/thread.write") {
        applyThreadWriteEvent(held, event.data as ThreadWriteData);
      }
    }

    return held;
  };

  test("a run confirms the batch it was woken with, so the next run is not handed it", async () => {
    freshKv();

    const first = reader();
    const cold = held({ seq: 3, taken: 0, entries: [] });

    cold.entries = ["one", "two", "three"].map((content, at) => {
      return {
        seq: at + 1,
        id: `evt-${at + 1}`,
        name: "agent/message",
        data: { agent: ref, thread: "t1", content },
        ts: 0,
      };
    });

    // A run woken by the batch of three, with the thread holding all three and
    // nothing taken up.
    const run1 = await run(first.fn, {
      forward: false,
      event: forward(["one", "two", "three"], { state: cold }),
    });

    expect(first.seen).toEqual(["one", "two", "three"]);

    const held1 = after(cold, run1.sent);

    // It said so where it read them, not from a count it kept until it ended.
    expect(held1.taken).toBe(3);

    // So a later run on the same thread is handed nothing of theirs.
    const second = reader();

    await run(second.fn, {
      event: message("four", "t1"),
      thread: held1,
    });

    expect(second.seen).toEqual(["four"]);
  });

  test("a run started by the message itself confirms that entry too", async () => {
    freshKv();

    const first = reader();
    const cold = held({
      seq: 1,
      taken: 0,
      entries: [
        {
          seq: 1,
          id: "evt-1",
          name: "agent/message",
          data: { agent: ref, thread: "t1", content: "one" },
          ts: 0,
        },
      ],
    });
    // The agent's own trigger started it, and its event is the entry the
    // thread holds: the same id, so it leads nothing and is handed over as the
    // run's event.
    const run1 = await run(first.fn, {
      event: { ...message("one"), id: "evt-1" },
      thread: cold,
    });
    const held1 = after(cold, run1.sent);

    expect(held1.taken).toBe(1);

    const second = reader();

    await run(second.fn, { event: message("two", "t1"), thread: held1 });

    expect(second.seen).toEqual(["two"]);
  });
});

describe("an entry that arrives while the run works", () => {
  test("is confirmed too, so the next run is not handed it again", async () => {
    freshKv();

    const seen: unknown[] = [];
    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox, step }) => {
        for (const one of await inbox.drain()) {
          seen.push((one.data as { content?: unknown }).content);
        }

        await step.run("work", async () => {
          return null;
        });

        for (const one of await inbox.drain()) {
          seen.push((one.data as { content?: unknown }).content);
        }

        return null;
      },
    );
    const cold = held({
      seq: 1,
      taken: 0,
      entries: [
        {
          seq: 1,
          id: "evt-1",
          name: "agent/message",
          data: { agent: ref, thread: "t1", content: "one" },
          ts: 0,
        },
      ],
    });

    // Woken by the first message, with another arriving while it works -
    // property 2's shape. Its position is in NEITHER the state the run
    // obtained nor the batch that woke it, so a run that counted positions in
    // memory and wrote the count when it ended wrote the position it started
    // with: the thread stayed where it was and handed the entry to the next
    // run, which answered it again.
    const run1 = await run(made.fn, {
      forward: true,
      event: { ...message("one"), id: "evt-1" },
      thread: cold,
      arrive: [{ event: { ...message("two"), id: "evt-2" }, at: "work" }],
    });
    const held1 = structuredClone(cold);

    for (const event of run1.sent) {
      if (event.name === "agent/thread.write") {
        applyThreadWriteEvent(held1, event.data as ThreadWriteData);
      }
    }

    const takes = run1.sent.flatMap((event) => {
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

    expect(seen).toContain("two");
    expect(held1.taken).toBeGreaterThanOrEqual(2);

    // One confirmation per batch, each sent where that batch was handed over.
    // A single confirmation at the end is the shape that broke: it is written
    // from whatever the final request re-derived, so a batch handed over in an
    // earlier request leaves the thread where it was.
    expect(takes).toEqual([1, 2]);
  });
});

describe("a confirmation is never refused", () => {
  test("a write of nothing but takes is applied even when its id was seen", () => {
    const state = held({ seq: 9, taken: 0 });
    const confirm = {
      agent: ref,
      thread: "t1",
      id: "run:take:4",
      ops: [{ kind: "take" as const, seq: 4 }],
    };

    expect(applyThreadWriteEvent(state, confirm)).toBe(true);
    expect(state.taken).toBe(4);

    // The dedupe is there to stop a stale CHANGE reverting a newer one. A
    // confirmation is not a change: it says how far a run has read, the
    // maximum is what applies it, and applying it again is a no-op. There is
    // nothing for the dedupe to protect and plenty for it to break - a refused
    // confirmation leaves the watermark where it was, and the thread hands
    // those entries to the next run, which answers them again.
    expect(applyThreadWriteEvent(state, confirm)).toBe(true);
    expect(state.taken).toBe(4);

    expect(
      applyThreadWriteEvent(state, {
        ...confirm,
        ops: [{ kind: "take" as const, seq: 7 }],
      }),
    ).toBe(true);
    expect(state.taken).toBe(7);

    // And it never goes backwards, whichever order they arrive in.
    expect(
      applyThreadWriteEvent(state, {
        ...confirm,
        id: "run:take:2",
        ops: [{ kind: "take" as const, seq: 2 }],
      }),
    ).toBe(true);
    expect(state.taken).toBe(7);
  });

  test("a change is still refused when its id was seen", () => {
    const state = held();
    const change = {
      agent: ref,
      thread: "t1",
      id: "run:3",
      ops: [{ kind: "set" as const, key: "k", value: '"first"' }],
    };

    expect(applyThreadWriteEvent(state, change)).toBe(true);
    expect(
      applyThreadWriteEvent(state, {
        ...change,
        ops: [{ kind: "set" as const, key: "k", value: '"second"' }],
      }),
    ).toBe(false);
    expect(state.keys.k?.v).toBe('"first"');
  });
});

describe("every reader that hands a message over confirms it", () => {
  const logged = (contents: string[]) => {
    return contents.map((content, at) => {
      return {
        seq: at + 1,
        id: `evt-${at + 1}`,
        name: "agent/message",
        data: { agent: ref, thread: "t1", content },
        ts: 0,
      };
    });
  };

  const takesOf = (sent: { name: string; data?: unknown }[]) => {
    return sent.flatMap((event) => {
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
  };

  test("a run that reads one message at a time confirms them", async () => {
    freshKv();

    const seen: unknown[] = [];
    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox }) => {
        for (;;) {
          const message = await inbox.next();

          if (!message) {
            break;
          }

          seen.push((message.data as { content?: unknown }).content);
        }

        return null;
      },
    );
    const { sent } = await run(made.fn, {
      event: { ...message("one"), id: "evt-1" },
      thread: held({
        seq: 3,
        taken: 0,
        entries: logged(["one", "two", "three"]),
      }),
    });

    // `inbox.next()` has its own path and did not go through the one place
    // that confirms, so a run reading this way confirmed NOTHING - for any
    // message, however many it took - and the thread handed all of them to the
    // next run. An agent that reads with a timeout reads this way.
    expect(takesOf(sent).at(-1)).toBe(3);
  });
  test("an entry newer than the message that woke the run trails it", async () => {
    freshKv();

    const seen: unknown[] = [];
    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox }) => {
        for await (const one of inbox) {
          const content = (one.data as { content?: unknown }).content;

          // The fake executor replays the run, so a message reaches the body
          // more than once; the order they first arrive in is the point.
          if (!seen.includes(content)) {
            seen.push(content);
          }
        }

        return null;
      },
    );

    // The thread held an older entry, then the one that woke this run, then
    // one that arrived while the run was starting. The log is ordered, and the
    // run's own event sits in the middle of it.
    await run(made.fn, {
      event: { ...message("waking"), id: "evt-2" },
      thread: held({
        seq: 3,
        taken: 0,
        entries: [
          ...logged(["older"]).map((entry) => {
            return { ...entry, id: "evt-1" };
          }),
          {
            seq: 2,
            id: "evt-2",
            name: "agent/message",
            data: { agent: ref, thread: "t1", content: "waking" },
            ts: 0,
          },
          {
            seq: 3,
            id: "evt-3",
            name: "agent/message",
            data: { agent: ref, thread: "t1", content: "newer" },
            ts: 0,
          },
        ],
      }),
    });

    expect(seen).toEqual(["older", "waking", "newer"]);
  });
});

describe("a run with an open child", () => {
  test("reads with next() through for-await, and still confirms", async () => {
    freshKv();

    const seen: unknown[] = [];
    const made = createAgentFunction(
      client(),
      { id: "bot" },
      async ({ inbox }) => {
        // An open child is what makes `quietNow()` non-zero, which is the one
        // condition that reroutes `for await` onto `next()`. So this body
        // reads through the path that confirmed nothing, without naming it.
        const instance = getAsyncCtxSync()?.execution?.instance;

        if (instance) {
          trackChild(instance, `${testClientId}/child:c1`);
        }

        for await (const one of inbox) {
          const content = (one.data as { content?: unknown }).content;

          if (!seen.includes(content)) {
            seen.push(content);
          }
        }

        return null;
      },
    );
    const { sent } = await run(made.fn, {
      event: { ...message("one"), id: "evt-1" },
      thread: held({
        seq: 2,
        taken: 0,
        entries: [
          {
            seq: 1,
            id: "evt-1",
            name: "agent/message",
            data: { agent: ref, thread: "t1", content: "one" },
            ts: 0,
          },
          {
            seq: 2,
            id: "evt-2",
            name: "agent/message",
            data: { agent: ref, thread: "t1", content: "two" },
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

    expect(seen).toContain("two");
    expect(takes.at(-1)).toBe(2);
  });
});

describe("why an unconfirmed watermark is not enough on its own", () => {
  const logged = (contents: string[]) => {
    return contents.map((content, at) => {
      return {
        seq: at + 1,
        id: `evt-${at + 1}`,
        name: "agent/message",
        data: { agent: ref, thread: "t1", content },
        ts: 0,
      };
    });
  };

  test("a run a forward woke sees nothing twice, even with the watermark at 0", async () => {
    freshKv();

    const { fn, seen } = reader();

    // The thread holds three entries and has confirmed NONE of them, so a
    // read would hand all three back as catch-up. This run is woken by a
    // forward that carries those same three, and the batch's own entries are
    // left out of the catch-up: so it sees each exactly once.
    //
    // Which is why "the watermark never advanced" is not sufficient for the
    // symptom. The duplicate needs the NEXT run to arrive by the route that
    // uses the catch-up - its own trigger - rather than by a forward carrying
    // the same entries. Both routes exist for every message, and which one
    // wins the agent's singleton is a race, which is what makes the symptom
    // rare and unquotable rather than conditional on anything in the state.
    await run(fn, {
      forward: false,
      event: forward(["one", "two", "three"], {
        state: held({
          seq: 3,
          taken: 0,
          entries: logged(["one", "two", "three"]),
        }),
      }),
    });

    expect(seen).toEqual(["one", "two", "three"]);
  });

  test("a run its own trigger woke sees them again, which is the symptom", async () => {
    freshKv();

    const { fn, seen } = reader();

    // The same unconfirmed thread, but this run was started by the fourth
    // message directly rather than by a forward. Nothing excludes the three
    // the thread still holds, so they lead the inbox: the entries a previous
    // run already answered are answered again.
    await run(fn, {
      event: { ...message("four"), id: "evt-4" },
      thread: held({
        seq: 4,
        taken: 0,
        entries: logged(["one", "two", "three", "four"]),
      }),
    });

    expect(seen).toEqual(["one", "two", "three", "four"]);
  });
});
