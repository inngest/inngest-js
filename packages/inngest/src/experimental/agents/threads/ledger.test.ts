import { expect, test } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import {
  applyChange,
  createLedgerFunctions,
  emptyThreadState,
  ledgerIsServed,
  liveKey,
  overLimitMessage,
  type Stamp,
  stateSize,
  type ThreadChange,
  ThreadResolver,
  type ThreadWriteData,
  threadStateLimit,
} from "./ledger.ts";

const at = (ts: number, runId = "w", seq = 1): Stamp => [ts, runId, seq];

const write = (
  runId: string,
  seq: number,
  change: ThreadChange,
  extra: Partial<ThreadWriteData> = {},
): ThreadWriteData => {
  return { thread: "t", app: "a", runId, seq, change, ...extra };
};

test("ledger: changes resolve in the order of their stamps", () => {
  const state = emptyThreadState();

  applyChange(state, { op: "set", key: "a", value: 1 }, at(1));
  applyChange(state, { op: "set", key: "a", value: 2 }, at(3));
  applyChange(state, { op: "set", key: "a", value: 9 }, at(2));
  applyChange(
    state,
    { op: "indexAdd", index: "i", member: "m", score: 5 },
    at(1),
  );

  expect(liveKey(state, "a", 0)?.v).toBe(2);
  expect(state.indexes.i?.m?.s).toBe(5);

  applyChange(state, { op: "indexRemove", index: "i", member: "m" }, at(2));
  applyChange(state, { op: "delete", key: "a" }, at(4));
  applyChange(state, { op: "set", key: "a", value: 7 }, at(3, "late"));

  expect(state.indexes.i?.m?.del).toBe(true);
  expect(liveKey(state, "a", 0)).toBeUndefined();
});

test("ledger: ties on the time go to the writer, then the seq", () => {
  const state = emptyThreadState();

  applyChange(state, { op: "set", key: "k", value: "b" }, at(5, "b", 1));
  applyChange(state, { op: "set", key: "k", value: "a" }, at(5, "a", 9));
  expect(liveKey(state, "k", 0)?.v).toBe("b");

  applyChange(state, { op: "set", key: "k", value: "b2" }, at(5, "b", 2));
  expect(liveKey(state, "k", 0)?.v).toBe("b2");
});

test("ledger: a clear removes what is older and refuses what is older", () => {
  const state = emptyThreadState();

  applyChange(state, { op: "set", key: "old", value: 1 }, at(1));
  applyChange(state, { op: "set", key: "new", value: 2 }, at(9));
  applyChange(state, { op: "clear" }, at(5));
  applyChange(state, { op: "set", key: "late", value: 3 }, at(4, "x"));

  expect(liveKey(state, "old", 0)).toBeUndefined();
  expect(liveKey(state, "late", 0)).toBeUndefined();
  expect(liveKey(state, "new", 0)?.v).toBe(2);
});

test("ledger: an expired key is gone and can be set again", () => {
  const state = emptyThreadState();

  applyChange(state, { op: "set", key: "k", value: 1, exp: 100 }, at(1));

  expect(liveKey(state, "k", 99)?.v).toBe(1);
  expect(liveKey(state, "k", 100)).toBeUndefined();

  applyChange(state, { op: "set", key: "k", value: 2 }, at(2));

  expect(liveKey(state, "k", 100)?.v).toBe(2);
});

test("ledger: the size limit message names the thread and the limit", () => {
  const state = emptyThreadState();

  applyChange(
    state,
    { op: "set", key: "big", value: "x".repeat(threadStateLimit) },
    at(1),
  );

  const size = stateSize(state);

  expect(size).toBeGreaterThan(threadStateLimit);
  expect(overLimitMessage("t", size)).toContain(`limit of ${threadStateLimit}`);
});

test("resolver: any arrival order of the same writes gives the same state", () => {
  const writes: Array<[ThreadWriteData, number]> = [
    [write("a", 1, { op: "set", key: "k", value: "a1" }), 10],
    [write("b", 1, { op: "set", key: "k", value: "b1" }), 11],
    [write("a", 2, { op: "set", key: "k", value: "a2" }), 12],
    [write("b", 2, { op: "delete", key: "j" }), 13],
    [write("a", 3, { op: "set", key: "j", value: "a3" }), 9],
  ];
  const resolve = (order: number[]) => {
    const resolver = new ThreadResolver();

    for (const i of order) {
      const [w, ts] = writes[i] as [ThreadWriteData, number];

      resolver.take(w, ts);
    }

    return resolver.state;
  };

  const forward = resolve([0, 1, 2, 3, 4]);

  expect(resolve([4, 3, 2, 1, 0])).toEqual(forward);
  expect(resolve([2, 0, 3, 1, 4])).toEqual(forward);
  expect(liveKey(forward, "k", 0)?.v).toBe("a2");
  expect(liveKey(forward, "j", 0)).toBeUndefined();
});

test("resolver: a writer's later write waits for the earlier one", () => {
  const resolver = new ThreadResolver();

  resolver.take(write("a", 2, { op: "set", key: "k", value: 2 }), 5);

  expect(resolver.waiting).toBe(1);
  expect(liveKey(resolver.state, "k", 0)).toBeUndefined();

  resolver.take(write("a", 1, { op: "set", key: "k", value: 1 }), 4);

  expect(resolver.waiting).toBe(0);
  expect(liveKey(resolver.state, "k", 0)?.v).toBe(2);
  expect(resolver.last.get("a")).toBe(2);
});

test("resolver: a write taken twice changes nothing, and a resend keeps its time", () => {
  const resolver = new ThreadResolver();
  const first = write("a", 1, { op: "set", key: "k", value: "a" });

  resolver.take(first, 5);
  resolver.take(write("b", 1, { op: "set", key: "k", value: "b" }), 8);
  resolver.take({ ...first, at: 5 }, 20);

  expect(liveKey(resolver.state, "k", 0)?.v).toBe("b");

  const fresh = new ThreadResolver();

  fresh.take(write("b", 1, { op: "set", key: "k", value: "b" }), 8);
  fresh.take(
    write("a", 7, { op: "set", key: "k", value: "a" }, { at: 5, from: 7 }),
    20,
  );

  expect(liveKey(fresh.state, "k", 0)?.v).toBe("b");
  expect(fresh.waiting).toBe(0);
});

test("resolver: a writer outside a run is not held for a gap", () => {
  const resolver = new ThreadResolver();

  resolver.take(write("ext-1", 5, { op: "set", key: "k", value: 1 }), 5);

  expect(liveKey(resolver.state, "k", 0)?.v).toBe(1);
  expect(resolver.waiting).toBe(0);
});

test("resolver: a write past the size limit is refused and the state stays", () => {
  const resolver = new ThreadResolver();

  resolver.take(write("a", 1, { op: "set", key: "k", value: 1 }), 1);

  const refused = resolver.take(
    write("a", 2, {
      op: "set",
      key: "big",
      value: "x".repeat(threadStateLimit),
    }),
    2,
  );

  expect(refused).toHaveLength(1);
  expect(liveKey(resolver.state, "big", 0)).toBeUndefined();
  expect(resolver.last.get("a")).toBe(2);
});

test("ledger: an app is served only once its ledger functions are made", () => {
  const client = new Inngest({ id: "ledger-served-probe", isDev: true });

  expect(ledgerIsServed(client.id)).toBe(false);
  createLedgerFunctions(client);
  expect(ledgerIsServed(client.id)).toBe(true);
});
