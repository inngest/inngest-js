/**
 * @module
 * The port the tour listens on: one fixed default so the live tour keeps one
 * address, overridden by `TOUR_PORT`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tourPort } from "../scripts/lib.ts";

describe("the tour's port", () => {
  it("is the same fixed, unprivileged port every time", () => {
    const port = tourPort({});

    assert.equal(tourPort({}), port);
    assert.ok(port > 1024 && port < 49152);
  });

  it("is overridden by TOUR_PORT", () => {
    assert.equal(tourPort({ TOUR_PORT: "5123" }), 5123);
  });

  it("ignores a TOUR_PORT that is not a port", () => {
    assert.equal(tourPort({ TOUR_PORT: "nope" }), tourPort({}));
  });
});
