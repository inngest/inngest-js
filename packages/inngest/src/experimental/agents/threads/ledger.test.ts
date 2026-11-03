import { expect, test } from "vitest";
import {
  applyChange,
  emptyThreadState,
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
