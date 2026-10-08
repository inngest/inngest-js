/**
 * Tests for saving and reading fixtures on disk.
 *
 * @module
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  checkFixtureName,
  listFixtures,
  loadFixture,
  loadFixtures,
  saveFixture,
} from "./fixtureStore.ts";
import type { SetupError } from "./setupError.ts";

const dir = () => {
  return mkdtempSync(join(tmpdir(), "ci-fixtures-"));
};

describe("fixtures", () => {
  test("saves under fixtures/<target>/<name>.json with the time", () => {
    const root = dir();

    saveFixture({
      dir: root,
      targetId: "deploy",
      name: "nightly-api",
      input: { trigger: "ci/manual.deploy", data: { target: "api" } },
      now: Date.UTC(2026, 9, 6),
    });

    expect(
      JSON.parse(
        readFileSync(
          join(root, "fixtures", "deploy", "nightly-api.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      trigger: "ci/manual.deploy",
      data: { target: "api" },
      savedAt: "2026-10-06T00:00:00.000Z",
    });
  });

  test("reads back what was saved, without the time", () => {
    const root = dir();
    const input = { input: { target: "web" }, combos: [{ os: "linux" }] };

    saveFixture({ dir: root, targetId: "build", name: "web", input, now: 0 });

    expect(loadFixture(root, "build", "web")).toEqual(input);
    expect(loadFixtures(root, "build")).toEqual({ web: input });
  });

  test("reads everything saved for a target, the one saved longest ago first", () => {
    const root = dir();

    for (const [name, now] of [
      ["b", 2000],
      ["a", 3000],
      ["c", 1000],
    ] as const) {
      saveFixture({ dir: root, targetId: "t", name, input: {}, now });
    }

    expect(Object.keys(loadFixtures(root, "t"))).toEqual(["c", "b", "a"]);
  });

  test("lists names sorted, and nothing for a target with none", () => {
    const root = dir();

    for (const name of ["b", "a"]) {
      saveFixture({ dir: root, targetId: "t", name, input: {}, now: 0 });
    }

    expect(listFixtures(root, "t")).toEqual(["a", "b"]);
    expect(listFixtures(root, "other")).toEqual([]);
  });

  test("a missing fixture is a setup error that lists what exists", () => {
    const root = dir();

    saveFixture({ dir: root, targetId: "t", name: "a", input: {}, now: 0 });

    expect.assertions(3);

    try {
      loadFixture(root, "t", "nope");
    } catch (error) {
      expect((error as SetupError).message).toContain('"nope"');
      expect((error as SetupError).fix).toBe("Saved: a");
    }

    expect(() => loadFixture(root, "other", "a")).toThrow(/No fixture/);
  });

  test("won't read a name that escapes the folder", () => {
    expect(() => loadFixture(dir(), "t", "../x")).toThrow(/No fixture/);
  });
});

describe("checkFixtureName", () => {
  test("allows file-safe names only", () => {
    expect(checkFixtureName("nightly-api_1.v2")).toBeUndefined();
    expect(checkFixtureName("has space")).toBeDefined();
    expect(checkFixtureName("a/b")).toBeDefined();
  });
});
