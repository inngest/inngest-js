/**
 * @module
 * What `pnpm tour:check` reports: one test per rule, each by changing a copy
 * of the fixture lessons.
 */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  type CheckOptions,
  checkLessons,
  defaults,
} from "../scripts/lesson-checks.ts";

const fixtures = join(import.meta.dirname, "fixtures", "lessons");
const made: string[] = [];

const withLessons = (change: (lessons: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "check-"));

  made.push(dir);
  cpSync(fixtures, dir, { recursive: true });
  change(dir);

  return checkLessons({ ...defaults, lessonsDir: dir });
};

const write = (dir: string, path: string, content: string) => {
  writeFileSync(join(dir, path), content);
};

describe("the lesson checks", () => {
  after(() => {
    for (const dir of made) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("find nothing wrong with good lessons", async () => {
    assert.deepEqual(
      await checkLessons({ ...defaults, lessonsDir: fixtures }),
      [],
    );
  });

  it("fail a page without a title", async () => {
    const problems = await withLessons((dir) => {
      write(dir, "01-first/01-hello/page.md", "\nNo title line.\n");
    });

    assert.deepEqual(problems, ["first/hello: page.md has no title line"]);
  });

  it("fail a key hint that names no action", async () => {
    const problems = await withLessons((dir) => {
      write(dir, "01-first/01-hello/page.md", "# Hello\n\nPress {Nope}.\n");
    });

    assert.deepEqual(problems, [
      "first/hello: {Nope} in the text names no action in the key table",
    ]);
  });

  it("fail a panel that is not registered", async () => {
    const problems = await withLessons((dir) => {
      write(dir, "01-first/01-hello/manifest.json", '{ "panels": ["nope"] }');
    });

    assert.deepEqual(problems, [
      "first/hello: panel nope is not registered (panels/nope.panel.tsx)",
    ]);
  });

  it("pass a panel that is registered", async () => {
    const problems = await withLessons((dir) => {
      write(dir, "01-first/01-hello/manifest.json", '{ "panels": ["slack"] }');
    });

    assert.deepEqual(problems, []);
  });

  it("fail a start entry for an agent no editable file defines", async () => {
    const problems = await withLessons((dir) => {
      write(
        dir,
        "01-first/01-hello/manifest.json",
        '{ "start": [{ "agent": "ghost", "thread": "t", "text": "hi" }] }',
      );
    });

    assert.deepEqual(problems, [
      "first/hello: start entry names agent ghost, which no editable file defines",
    ]);
  });

  it("fail an exercise without its check file", async () => {
    const problems = await withLessons((dir) => {
      unlinkSync(join(dir, "01-first/03-exercise/check.ts"));
    });

    assert.deepEqual(problems, ["first/exercise: no check file check.ts"]);
  });

  it("fail a Go deeper page that is an exercise", async () => {
    const problems = await withLessons((dir) => {
      cpSync(
        join(dir, "01-first/03-exercise"),
        join(dir, "01-first/03a-extra"),
        { recursive: true },
      );
    });

    assert.deepEqual(problems, [
      "first/extra: a Go deeper page cannot be an exercise",
    ]);
  });

  it("fail a page with no editable file", async () => {
    const problems = await withLessons((dir) => {
      write(dir, "01-first/01-hello/manifest.json", '{ "editable": [] }');
    });

    assert.deepEqual(problems, ["first/hello: no editable file"]);
  });

  it("fail a file Biome would change", async () => {
    const problems = await withLessons((dir) => {
      write(dir, "01-first/01-hello/agent.ts", "export const hello   = 1\n");
    });

    assert.deepEqual(problems, [
      "first/hello: agent.ts is not formatted; run biome format --write",
    ]);
  });

  it("fail a file Biome cannot parse", async () => {
    const problems = await withLessons((dir) => {
      write(dir, "01-first/01-hello/agent.ts", "export const (\n");
    });

    assert.deepEqual(problems, [
      "first/hello: agent.ts cannot be formatted by Biome",
    ]);
  });

  it("fail a solution Biome would change", async () => {
    const problems = await withLessons((dir) => {
      write(
        dir,
        "01-first/03-exercise/solution/agent.ts",
        "export const a   = 1\n",
      );
    });

    assert.deepEqual(problems, [
      "first/exercise: agent.ts is not formatted; run biome format --write",
    ]);
  });

  it("report a lesson the loader refuses", async () => {
    const problems = await withLessons((dir) => {
      write(
        dir,
        "01-first/01-hello/manifest.json",
        '{ "readOnly": ["nope.ts"] }',
      );
    });

    assert.deepEqual(problems, ["first/hello: no shared file nope.ts"]);
  });

  it("fail two actions that bind the same key", async () => {
    const keysDir = mkdtempSync(join(tmpdir(), "keys-"));

    made.push(keysDir);
    write(
      keysDir,
      "core.ts",
      'export const coreKeys = [{ id: "a", label: "x", group: "G", inField: [], outside: ["q"] }, { id: "b", label: "x", group: "G", inField: [], outside: ["q"] }];\n',
    );

    const options: CheckOptions = {
      ...defaults,
      lessonsDir: fixtures,
      keysDir,
    };
    const problems = await checkLessons(options);

    assert.ok(
      problems.some((line) => line.includes("out:q is bound to both a and b")),
    );
  });
});
