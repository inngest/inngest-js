/**
 * Tests for where the app's `node_modules/.bin` directories are searched.
 *
 * @module
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { binDirs, waitForSync } from "./app.ts";

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

describe("waitForSync", () => {
  test.each([
    {
      name: "a CiUsageError in the log",
      log: "boot\nCiUsageError: Job IDs must be unique per app.\n    at defineJob",
      fix: "Job IDs must be unique per app.",
    },
    { name: "any other crash", log: "Error: boom", fix: undefined },
  ])("an app that exits with $name says so", async ({ log, fix }) => {
    const logPath = join(mkdtempSync(join(tmpdir(), "app-log-")), "app.log");

    writeFileSync(logPath, log);

    const error = await waitForSync({
      devServerUrl: "http://localhost:1",
      app: { pid: 1, logPath, hasExited: () => true },
      manifest: new Promise(() => {}),
    }).catch((e: unknown) => {
      return e;
    });

    expect(error).toMatchObject({
      message: "The app exited before it was ready.",
      fix,
    });
  });
});
