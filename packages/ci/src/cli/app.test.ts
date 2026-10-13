/**
 * Tests for where the app's `node_modules/.bin` directories are searched.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { binDirs } from "./app.ts";

describe("binDirs", () => {
  test("lists node_modules/.bin from the project up to the git root, nearest first", () => {
    expect(binDirs("/repo/apps/ci", "/repo")).toEqual([
      "/repo/apps/ci/node_modules/.bin",
      "/repo/apps/node_modules/.bin",
      "/repo/node_modules/.bin",
    ]);
  });

  test("is just the project's when it is the git root", () => {
    expect(binDirs("/repo", "/repo")).toEqual(["/repo/node_modules/.bin"]);
  });

  test("stops at the filesystem root if the git root isn't above", () => {
    expect(binDirs("/a", "/elsewhere")).toEqual([
      "/a/node_modules/.bin",
      "/node_modules/.bin",
    ]);
  });
});
