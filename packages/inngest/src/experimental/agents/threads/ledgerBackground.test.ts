/**
 * @module
 * The thread-state copy of a run is read once and kept current by a background
 * reader. These tests replay a run against stacks the executor could have
 * saved and check that an arrival changes the same read of the code on every
 * replay, that nothing is applied twice, and that a handover still delivers.
 */
import {
  getAsyncCtxSync,
  stepsIssued,
} from "../../../components/execution/als.ts";
import {
  hashedStepId,
  inboxKey,
} from "../../../components/execution/inboxState.ts";
import { Inngest } from "../../../components/Inngest.ts";
import { runFnWithStack } from "../../../test/helpers.ts";
import { signLedgerData } from "../agent/relations.ts";
import {
  applyChange,
  createLedgerFunctions,
  emptyThreadState,
} from "./ledger.ts";
import {
  closesCopies,
  closeThreadCopies,
  ledgerKvAdapter,
} from "./ledgerClient.ts";

const client = new Inngest({
  id: "bg-app",
  isDev: true,
  signingKey: "signkey-test-aaaa",
});

createLedgerFunctions(client);

const thread = "inngest:kv:thread:default:bg-app:t";
const opened = hashedStepId(`ledger-state:${thread}`);
const sign = (name: string, data: Record<string, unknown>) => {
  return signLedgerData(client, name, { thread, app: "bg-app", ...data });
};

interface Entry {
  id: string;
  data: unknown;
}

const memo = (id: string, data: unknown): Entry => {
  return { id: hashedStepId(id), data };
};

const message = (id: string, name: string, ts: number, data: object): Entry => {
  return {
    id,
    data: {
      data: { id, name, ts, data },
      [inboxKey]: opened,
    },
  };
};

const base = (): Entry[] => {
  const state = emptyThreadState();

  applyChange(state, { op: "set", key: "k", value: "old" }, [1, "w0", 1]);

  return [
    memo(`ledger-state:${thread}`, { pauses: [] }),
    memo(`ledger-read:${thread}:1`, { ids: ["r"] }),
    message(
      "reply",
      "agent/thread.state",
      2,
      sign("agent/thread.state", {
        runId: "run",
        n: 1,
        epoch: "e1",
        state,
        last: { w0: 1 },
      }),
    ),
  ];
};

const write = (
  id: string,
  ts: number,
  seq: number,
  value: string,
  runId = "other",
  extra: Record<string, unknown> = {},
): Entry => {
  return message(
    id,
    "agent/thread.write",
    ts,
    sign("agent/thread.write", {
      runId,
      seq,
      change: { op: "set", key: "k", value },
      ...extra,
    }),
  );
};

const ready = (id: string, last: Record<string, number>): Entry => {
  return message(
    id,
    "agent/thread.ready",
    10,
    sign("agent/thread.ready", { epoch: "e2", last }),
  );
};

const stateOf = (entries: Entry[]) => {
  return Object.fromEntries(
    entries.map((entry) => {
      return [entry.id, { id: entry.id, data: entry.data }];
    }),
  );
};

/**
 * A function that reads the key between steps, so each read sits at a place of
 * the code that a message in the stack can fall before or after.
 */
const begin = () => {
  closesCopies(getAsyncCtxSync()?.execution?.instance as object);
};

const end = async () => {
  await closeThreadCopies(getAsyncCtxSync()?.execution?.instance as object);
};

const reader = (seen: unknown[]) => {
  return client.createFunction(
    { id: "bg-reader", triggers: [{ event: "bg/go" }] },
    async ({ step }) => {
      const store = ledgerKvAdapter();

      begin();
      seen.push(await store.get(thread, "k"));
      await step.run("a", () => {
        return 1;
      });
      seen.push(await store.get(thread, "k"));
      await step.run("b", () => {
        return 2;
      });
      seen.push(await store.get(thread, "k"));
      await end();

      return "done";
    },
  );
};

const go = async (
  fn: ReturnType<typeof reader>,
  entries: Entry[],
  runId = "run",
) => {
  const event = { name: "bg/go", ts: 1, data: {} };

  return runFnWithStack(fn, stateOf(entries), {
    event,
    events: [event],
    stackOrder: entries.map((entry) => {
      return entry.id;
    }),
    runId,
  });
};

const reads = async (entries: Entry[]) => {
  const seen: unknown[] = [];
  const result = await go(reader(seen), entries);

  return { seen, result };
};

/**
 * Whether the request ended the run: lazy read rows can ride along with the
 * completion, so it may be reported as found steps that include `RunComplete`.
 */
const finished = (result: Awaited<ReturnType<typeof go>>): boolean => {
  return (
    result.type === "function-resolved" ||
    (result.type === "steps-found" &&
      result.steps.some((step) => {
        return step.op === "RunComplete";
      }))
  );
};

const closed = (cut: string | null = null): Entry => {
  return memo(`ledger-state:${thread}:close`, { cut });
};

const a = memo("a", 1);
const b = memo("b", 2);

describe("a background reader keeps the copy current", () => {
  test("reads before the arrival do not see it, reads after it do", async () => {
    // The write arrived after step a and before step b.
    const arrived = [...base(), a, write("m1", 5, 1, "new"), b, closed("m1")];
    const { seen, result } = await reads(arrived);

    expect(seen).toEqual(["old", "old", "new"]);
    expect(finished(result)).toBe(true);
  });

  test("a write saved before step a is seen by the read after a", async () => {
    const { seen } = await reads([...base(), write("m1", 5, 1, "new"), a, b]);

    expect(seen).toEqual(["old", "new", "new"]);
  });

  test("an arrival is applied at the same point on every replay", async () => {
    // The request that first saw the run reach b, then each request after the
    // write arrived: the reads they share agree.
    const requests: Entry[][] = [
      [...base()],
      [...base(), a],
      [...base(), a, write("m1", 5, 1, "new")],
      [...base(), a, write("m1", 5, 1, "new"), b],
    ];
    const observed: unknown[][] = [];

    for (const entries of requests) {
      observed.push((await reads(entries)).seen);
    }

    expect(observed).toEqual([
      ["old"],
      ["old", "old"],
      ["old", "old"],
      ["old", "old", "new"],
    ]);

    // Replaying the same stack again, as a retry does, reads the same.
    const last = requests.at(-1) as Entry[];

    expect((await reads(last)).seen).toEqual(["old", "old", "new"]);
    expect((await reads(last)).seen).toEqual(["old", "old", "new"]);
  });

  test("a read between steps costs no step, and the run waits on one read", async () => {
    const { result } = await reads([...base(), a]);

    expect(result.type).toBe("steps-found");

    if (result.type !== "steps-found") {
      throw new Error("unreachable");
    }

    const ops = result.steps.map((step) => {
      return step.op;
    });

    // Step b, and the reader's single wait: no drain, no per-read step.
    expect(ops.sort()).toEqual(["StepPlanned", "SubscribeWait"]);
  });

  test("a write applied twice is applied once", async () => {
    // The later write (ts 7) wins the key. A copy of the first, delivered
    // again (a resend) with a newer time, must not win.
    const { seen } = await reads([
      ...base(),
      write("m1", 5, 1, "first", "other"),
      write("m2", 7, 2, "second", "other"),
      write("m3", 9, 1, "first", "other"),
      a,
      b,
    ]);

    expect(seen).toEqual(["old", "second", "second"]);
  });

  test("an own write is in the copy at once and not applied again when it is heard back", async () => {
    const seen: unknown[] = [];
    const fn = client.createFunction(
      { id: "bg-own", triggers: [{ event: "bg/go" }] },
      async ({ step }) => {
        const store = ledgerKvAdapter();

        begin();
        await store.get(thread, "k");
        await store.set(thread, "k", "mine");
        seen.push(await store.get(thread, "k"));
        await step.run("a", () => {
          return 1;
        });
        seen.push(await store.get(thread, "k"));
        await end();

        return "done";
      },
    );
    const sent = memo(`ledger-write:${thread}:1`, { ids: ["x"] });
    // The ledger recorded the write at 4; another writer wrote at 6, later.
    const echo = write("own", 4, 1, "mine", "run");
    const theirs = write("m1", 6, 1, "theirs");

    await go(fn, [...base(), sent, echo, a, theirs]);

    // After the echo (own write, applied once) the read still says "mine";
    // another writer's later write is not heard until its place.
    expect(seen).toEqual(["mine", "mine"]);

    seen.length = 0;
    await go(fn, [...base(), sent, echo, theirs, a]);
    expect(seen).toEqual(["mine", "theirs"]);
  });
});

describe("a handover mid-run", () => {
  const writer = () => {
    const seen: unknown[] = [];
    const fn = client.createFunction(
      { id: "bg-writer", triggers: [{ event: "bg/go" }] },
      async ({ step }) => {
        const store = ledgerKvAdapter();

        begin();
        await store.get(thread, "k");
        await store.set(thread, "k", "mine");
        await step.run("a", () => {
          return 1;
        });
        seen.push(await store.get(thread, "k"));
        await step.run("b", () => {
          return 2;
        });
        await end();

        return "done";
      },
    );

    return { fn, seen };
  };
  const sent = memo(`ledger-write:${thread}:1`, { ids: ["x"] });

  test("a ledger that lacks the write is told it again, once", async () => {
    const { fn, seen } = writer();
    const stack = [...base(), sent, a, ready("rdy", { w0: 1 })];
    const first = await go(fn, stack);

    // The ready arrived after a: the read after a has not heard it yet, so no
    // resend step is issued there.
    expect(seen).toEqual(["mine"]);
    expect(first.type).toBe("steps-found");

    const ops = (first as { steps: { id: string; op: string }[] }).steps;

    expect(
      ops.some((op) => {
        return op.id === hashedStepId(`ledger-resend:${thread}:1`);
      }),
    ).toBe(false);

    // Heard before the read: the read sends the write again.
    const second = await go(fn, [...base(), sent, ready("rdy", { w0: 1 }), a]);
    const resend = (
      second as { steps: { id: string; op: string; opts?: unknown }[] }
    ).steps.find((op) => {
      return op.id === hashedStepId(`ledger-resend:${thread}:1`);
    });

    expect(resend?.op).toBe("StepPlanned");
  });

  test("the resend is not issued again once it is in the stack", async () => {
    const { fn } = writer();
    const resent = memo(`ledger-resend:${thread}:1`, { ids: ["y"] });
    const result = await go(fn, [
      ...base(),
      sent,
      ready("rdy", { w0: 1 }),
      a,
      resent,
      b,
      closed("rdy"),
    ]);

    expect(finished(result)).toBe(true);
  });

  test("a handover that held the write needs no resend", async () => {
    const { fn } = writer();
    const result = await go(fn, [
      ...base(),
      sent,
      ready("rdy", { w0: 1, run: 1 }),
      a,
      b,
      closed("rdy"),
    ]);

    expect(finished(result)).toBe(true);
  });

  test("the last writes met a handover: closing hears it and sends again", async () => {
    const fn = client.createFunction(
      { id: "bg-close", triggers: [{ event: "bg/go" }] },
      async () => {
        const store = ledgerKvAdapter();

        begin();
        await store.get(thread, "k");
        await store.set(thread, "k", "mine");
        await end();

        return "done";
      },
    );
    const stack = [...base(), sent, ready("rdy", { w0: 1 }), closed("rdy")];
    const result = await go(fn, stack);

    // With the subscription closed nothing waits beside the resend, so it runs
    // in the request.
    expect(result.type).toBe("step-ran");
    expect((result as { step: { id: string } }).step.id).toBe(
      hashedStepId(`ledger-resend:${thread}:1`),
    );
  });
});

describe("the background reader's reads are not the code's steps", () => {
  // The step count at each place of the code, as the inbox's drains see it.
  const counter = (counts: (number | undefined)[]) => {
    return client.createFunction(
      { id: "bg-count", triggers: [{ event: "bg/go" }] },
      async ({ step }) => {
        const store = ledgerKvAdapter();

        begin();
        await store.get(thread, "k");
        counts.push(stepsIssued());
        await step.run("a", () => {
          return 1;
        });
        counts.push(stepsIssued());
        await store.get(thread, "k");
        counts.push(stepsIssued());
        await step.run("b", () => {
          return 2;
        });
        counts.push(stepsIssued());
        await end();

        return "done";
      },
    );
  };

  test("the step count at a place of the code is the same on every replay", async () => {
    // Each request a replay of the one before, with writes saved meanwhile:
    // the reader reads more or less, and waits at different times.
    const requests: Entry[][] = [
      [...base()],
      [...base(), a],
      [...base(), write("m1", 5, 1, "new"), a],
      [...base(), write("m1", 5, 1, "new"), a, write("m2", 6, 2, "newer")],
      [
        ...base(),
        write("m1", 5, 1, "new"),
        a,
        write("m2", 6, 2, "newer"),
        b,
        write("m3", 7, 3, "newest"),
      ],
    ];
    const observed: (number | undefined)[][] = [];

    for (const entries of requests) {
      const counts: (number | undefined)[] = [];

      await go(counter(counts), entries);
      observed.push(counts);
    }

    const last = observed.at(-1) ?? [];

    expect(last).toHaveLength(4);

    for (const counts of observed) {
      expect(counts).toEqual(last.slice(0, counts.length));
    }
  });
});
