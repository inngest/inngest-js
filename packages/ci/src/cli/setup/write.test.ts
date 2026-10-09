/**
 * Tests for writing `inngest.json` and `.gitignore`.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  addIgnore,
  ignoreInngest,
  isInngestIgnored,
  mergeCiConfig,
  writeCiConfig,
} from "./write.ts";

const ci = { start: "tsx server.ts", path: "/api/inngest" };

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "ci-write-")));

  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("mergeCiConfig", () => {
  test("a new file has the ci key, with 2 spaces", () => {
    expect(mergeCiConfig(undefined, ci)).toBe(`{
  "ci": {
    "start": "tsx server.ts",
    "path": "/api/inngest"
  }
}
`);
  });

  test("keeps every other key, in place", () => {
    const merged = mergeCiConfig(
      '{\n  "name": "x",\n  "other": { "a": [1, 2] }\n}\n',
      ci,
    );

    expect(Object.keys(JSON.parse(merged))).toEqual(["name", "other", "ci"]);
    expect(JSON.parse(merged).other).toEqual({ a: [1, 2] });
  });

  test("keeps the ci keys it doesn't change and updates the ones it does", () => {
    const merged = mergeCiConfig(
      JSON.stringify({
        ci: { dir: "out", start: "old", devServer: { bin: "/x" } },
        after: true,
      }),
      ci,
    );

    expect(JSON.parse(merged)).toEqual({
      ci: {
        dir: "out",
        start: "tsx server.ts",
        devServer: { bin: "/x" },
        path: "/api/inngest",
      },
      after: true,
    });
    expect(Object.keys(JSON.parse(merged).ci)).toEqual([
      "dir",
      "start",
      "devServer",
      "path",
    ]);
  });

  test("keeps the file's indentation", () => {
    expect(mergeCiConfig('{\n\t"a": 1\n}\n', ci)).toContain(
      '\n\t"a": 1,\n\t"ci"',
    );
    expect(mergeCiConfig('{\n    "a": 1\n}\n', ci)).toContain(
      '\n    "ci": {\n        "start"',
    );
  });
});

describe("addIgnore", () => {
  test.each([
    ["", ".inngest/\n"],
    ["node_modules\n", "node_modules\n.inngest/\n"],
    ["node_modules", "node_modules\n.inngest/\n"],
  ])("%j", (text, expected) => {
    expect(addIgnore(text)).toBe(expected);
  });
});

describe("files", () => {
  test("writeCiConfig creates and then merges", async () => {
    await writeCiConfig(repo, ci);
    await writeCiConfig(repo, { start: "node s.js", path: "/x" });

    expect(
      JSON.parse(readFileSync(join(repo, "inngest.json"), "utf8")),
    ).toEqual({
      ci: { start: "node s.js", path: "/x" },
    });
  });

  test("ignoreInngest creates .gitignore, then git sees .inngest/ as ignored", async () => {
    expect(await isInngestIgnored(repo)).toBe(false);

    await ignoreInngest(repo);

    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(".inngest/\n");
    expect(await isInngestIgnored(repo)).toBe(true);
  });

  test("ignoreInngest appends to an existing .gitignore", async () => {
    writeFileSync(join(repo, ".gitignore"), "dist");

    await ignoreInngest(repo);

    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      "dist\n.inngest/\n",
    );
  });

  test("a broader rule already counts", async () => {
    writeFileSync(join(repo, ".gitignore"), ".inngest\n");

    expect(await isInngestIgnored(repo)).toBe(true);
  });
});
