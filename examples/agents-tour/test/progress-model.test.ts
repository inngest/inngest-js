/**
 * @module
 * What the nav and the chips show, worked out from the index and the
 * progress record: page symbols, module rows, deeper pages waiting and the
 * buttons at a module's end.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageSummary, TourIndex } from "../shared/types.ts";
import {
  deeperWaiting,
  moduleEnd,
  moduleRow,
  stateOf,
} from "../site/src/progress-model.ts";

const page = (
  module: string,
  label: string,
  extra: Partial<PageSummary> = {},
): PageSummary => {
  return {
    id: `${module}/p${label}`,
    label,
    kind: /[a-z]$/.test(label) ? "deeper" : "core",
    module,
    moduleTitle: module,
    title: `Page ${label}`,
    exercise: false,
    ...extra,
  };
};

const index: TourIndex = {
  modules: [
    {
      id: "a",
      title: "A",
      opening: "",
      pages: [
        page("a", "1"),
        page("a", "2", { exercise: true }),
        page("a", "2a"),
        page("a", "2b"),
      ],
    },
    {
      id: "b",
      title: "B",
      opening: "",
      pages: [page("b", "3"), page("b", "4", { exercise: true })],
    },
  ],
};

describe("progress model", () => {
  it("shows the furthest state a page reached", () => {
    assert.equal(stateOf({}, "a/p1"), "none");
    assert.equal(stateOf({ "a/p1": { opened: true } }, "a/p1"), "opened");
    assert.equal(
      stateOf({ "a/p1": { opened: true, ran: true } }, "a/p1"),
      "ran",
    );
    assert.equal(
      stateOf({ "a/p1": { opened: true, ran: true, passed: true } }, "a/p1"),
      "passed",
    );
  });

  it("fills a module's row from its core pages and its exercise", () => {
    const pages = {
      "a/p1": { opened: true },
      "a/p2": { opened: true, passed: true },
    };

    const row = moduleRow(
      index.modules[0] as TourIndex["modules"][number],
      pages,
    );

    assert.deepEqual(row, { core: 2, reached: 2, done: true });
  });

  it("does not call a module done when only a page that is not its exercise passed", () => {
    const row = moduleRow(index.modules[0] as TourIndex["modules"][number], {
      "a/p1": { opened: true, passed: true },
    });

    assert.equal(row.done, false);
  });

  it("lists the deeper pages left behind, once the reader is past the module", () => {
    assert.deepEqual(deeperWaiting(index, {}), []);

    const midway = { "a/p1": { opened: true } };

    assert.deepEqual(deeperWaiting(index, midway), []);

    const passed = { "a/p2": { opened: true, passed: true } };

    assert.deepEqual(
      deeperWaiting(index, passed).map((entry) => {
        return entry.label;
      }),
      ["2a", "2b"],
    );

    const movedOn = {
      "a/p2a": { opened: true },
      "b/p3": { opened: true },
    };

    assert.deepEqual(
      deeperWaiting(index, movedOn).map((entry) => {
        return entry.label;
      }),
      ["2b"],
    );
  });

  it("offers Next module and Go deeper on the last core page of a module", () => {
    const end = moduleEnd(index, "a/p2");

    assert.equal(end?.nextModule?.id, "b/p3");
    assert.equal(end?.deeper?.id, "a/p2a");
    assert.equal(moduleEnd(index, "a/p1"), null);
    assert.equal(moduleEnd(index, "b/p4")?.nextModule, undefined);
    assert.equal(moduleEnd(index, "b/p4")?.deeper, undefined);
  });
});
