import assert from "node:assert/strict";
import { test } from "node:test";

import { mean, sum } from "./sum.ts";

test("sum adds numbers", () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test("sum of nothing is zero", () => {
  assert.equal(sum([]), 0);
});

test("mean averages numbers", () => {
  assert.equal(mean([2, 4]), 3);
});

/**
 * Set `FLAKY=1` to make this fail roughly half the time, for the retry step of
 * the demo in the README.
 */
test("flaky when asked", () => {
  if (process.env.FLAKY === "1" && Math.random() < 0.5) {
    assert.fail("flaked");
  }
  assert.ok(true);
});
