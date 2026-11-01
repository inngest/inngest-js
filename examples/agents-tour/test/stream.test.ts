/**
 * @module
 * How the site hands stream events to its panels.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeStreamEvent } from "../site/src/stream.ts";

describe("routing stream events", () => {
  it("turns an area's event into a tour:area event with its topic and data", () => {
    const target = new EventTarget();
    const seen: unknown[] = [];

    target.addEventListener("tour:area", (event) => {
      seen.push((event as CustomEvent).detail);
    });

    const routed = routeStreamEvent(
      { type: "area", area: "ci", topic: "failed", data: { pr: 42 } },
      target,
    );

    assert.equal(routed, true);
    assert.deepEqual(seen, [{ area: "ci", topic: "failed", data: { pr: 42 } }]);
  });

  it("turns a fake's change into a tour:fakes event", () => {
    const target = new EventTarget();
    const seen: unknown[] = [];

    target.addEventListener("tour:fakes", (event) => {
      seen.push((event as CustomEvent).detail);
    });

    assert.equal(
      routeStreamEvent({ type: "fakes", topic: "slack" }, target),
      true,
    );
    assert.deepEqual(seen, ["slack"]);
  });

  it("leaves logs, status and runs to the page", () => {
    const target = new EventTarget();

    assert.equal(routeStreamEvent({ type: "clear" }, target), false);
    assert.equal(routeStreamEvent({ type: "runs", runs: [] }, target), false);
  });
});
