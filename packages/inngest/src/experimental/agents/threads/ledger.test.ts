import { expect, test } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import {
  applyChange,
  createLedgerFunctions,
  emptyThreadState,
  ledgerIsServed,
  liveKey,
  overLimitMessage,
  stateSize,
  threadStateLimit,
} from "./ledger.ts";

test("ledger: changes resolve in the order they are applied", () => {
  const state = emptyThreadState();

  applyChange(state, { op: "set", key: "a", value: 1 }, 0);
  applyChange(state, { op: "setIfAbsent", key: "a", value: 2 }, 0);
  applyChange(state, { op: "setIfAbsent", key: "b", value: 3 }, 0);
  applyChange(state, { op: "indexAdd", index: "i", member: "m", score: 5 }, 0);
  applyChange(state, { op: "set", key: "a", value: 4 }, 0);

  expect(liveKey(state, "a", 0)?.v).toBe(4);
  expect(liveKey(state, "b", 0)?.v).toBe(3);
  expect(state.indexes).toEqual({ i: { m: 5 } });

  applyChange(state, { op: "indexRemove", index: "i", member: "m" }, 0);
  applyChange(state, { op: "delete", key: "b" }, 0);

  expect(state.indexes).toEqual({});
  expect(liveKey(state, "b", 0)).toBeUndefined();

  applyChange(state, { op: "clear" }, 0);

  expect(state).toEqual(emptyThreadState());
});

test("ledger: an expired key is gone and can be set again", () => {
  const state = emptyThreadState();

  applyChange(state, { op: "set", key: "k", value: 1, exp: 100 }, 0);

  expect(liveKey(state, "k", 99)?.v).toBe(1);
  expect(liveKey(state, "k", 100)).toBeUndefined();

  applyChange(state, { op: "setIfAbsent", key: "k", value: 2 }, 100);

  expect(liveKey(state, "k", 100)?.v).toBe(2);
});

test("ledger: the size limit message names the thread and the limit", () => {
  const state = emptyThreadState();

  applyChange(
    state,
    { op: "set", key: "big", value: "x".repeat(threadStateLimit) },
    0,
  );

  const size = stateSize(state);

  expect(size).toBeGreaterThan(threadStateLimit);
  expect(overLimitMessage("t", size)).toContain(`limit of ${threadStateLimit}`);
});

test("ledger: a conditional change says whether it applied", () => {
  const state = emptyThreadState();
  const apply = (change: Parameters<typeof applyChange>[1]) => {
    return applyChange(state, change, 0);
  };

  expect(apply({ op: "setIfAbsent", key: "a", value: "1" })).toBe(true);
  expect(apply({ op: "setIfAbsent", key: "a", value: "2" })).toBe(false);
  expect(apply({ op: "cas", key: "a", expected: "0", value: "9" })).toBe(false);
  expect(apply({ op: "cas", key: "a", expected: "1", value: "2" })).toBe(true);
  expect(apply({ op: "cas", key: "b", expected: null, value: "x" })).toBe(true);
  expect(liveKey(state, "a", 0)?.v).toBe("2");
  expect(apply({ op: "casDelete", key: "a", expected: "1" })).toBe(false);
  expect(apply({ op: "casDelete", key: "a", expected: "2" })).toBe(true);
  expect(liveKey(state, "a", 0)).toBeUndefined();
});

test("ledger: an app is served only once its ledger functions are made", () => {
  const client = new Inngest({ id: "ledger-served-probe", isDev: true });

  expect(ledgerIsServed(client.id)).toBe(false);
  createLedgerFunctions(client);
  expect(ledgerIsServed(client.id)).toBe(true);
});
