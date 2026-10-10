/**
 * Tests for `localRepo()`, which says when a run reads its local working tree.
 *
 * @module
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { localRepo } from "./scope.ts";

const local = { path: "/repo", baseRef: "main" };

describe("localRepo", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test.each([
    ["local repository data", undefined, { repo: { local } }, local],
    ["no local data", undefined, { repo: {} }, undefined],
    ["no repository", undefined, {}, undefined],
    ["GitHub forced live", "live", { repo: { local } }, undefined],
    ["another GITHUB value", "mock", { repo: { local } }, local],
  ])("%s", (_name, github, run, expected) => {
    if (github) {
      vi.stubEnv("INNGEST_CI_GITHUB", github);
    }

    // biome-ignore lint/suspicious/noExplicitAny: partial run for a pure lookup
    expect(localRepo(run as any)).toEqual(expected);
  });
});
