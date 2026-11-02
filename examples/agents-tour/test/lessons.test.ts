/**
 * @module
 * The lesson format as `loadLessons` reads it: where read-only files are
 * found, what a bad folder or a missing file says, and what an exercise keeps.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadLessons } from "../server/lessons.ts";

const fixtures = join(import.meta.dirname, "fixtures", "lessons");

const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), "lessons-"));

  cpSync(fixtures, dir, { recursive: true });

  return dir;
};

describe("loading lessons", () => {
  it("shows setup.ts to a page that names no read-only file", () => {
    const { pages } = loadLessons(fixtures);
    const deeper = pages.find((page) => {
      return page.id === "first/deeper";
    });

    assert.deepEqual(
      deeper?.files.map((file) => {
        return [file.name, file.editable];
      }),
      [
        ["agent.ts", true],
        ["setup.ts", false],
      ],
    );
  });

  it("finds a read-only file in the module first, then tour-wide", () => {
    const { pages } = loadLessons(fixtures);
    const content = (id: string, name: string) => {
      return pages
        .find((page) => {
          return page.id === id;
        })
        ?.files.find((file) => {
          return file.name === name;
        })
        ?.content.trim();
    };

    assert.equal(
      content("first/hello", "setup.ts"),
      "export const moduleWide = true;",
    );
    assert.equal(
      content("first/more", "client.ts"),
      'export const client = "tour";',
    );
  });

  it("keeps an exercise's check, and its solution files from the solution folder", () => {
    const { pages } = loadLessons(fixtures);
    const exercise = pages.find((page) => {
      return page.id === "first/exercise";
    });

    assert.equal(
      exercise?.exerciseFiles?.check,
      join(fixtures, "01-first", "03-exercise", "check.ts"),
    );
    assert.deepEqual(
      exercise?.exerciseFiles?.solution.map((file) => {
        return [file.name, file.editable, file.content.trim()];
      }),
      [["agent.ts", true, 'export const answer = "solution";']],
    );
    assert.equal(
      exercise?.files[0]?.content.trim(),
      'export const answer = "stub";',
    );
  });

  it("gives a Go deeper page the label of its folder", () => {
    const { pages } = loadLessons(fixtures);

    assert.deepEqual(
      pages
        .filter((page) => {
          return page.module === "first";
        })
        .map((page) => {
          return [page.label, page.kind];
        }),
      [
        ["1", "core"],
        ["2", "core"],
        ["2a", "deeper"],
        ["3", "core"],
      ],
    );
  });

  it("names the page when a read-only file is nowhere", () => {
    const dir = copy();

    writeFileSync(
      join(dir, "01-first", "01-hello", "manifest.json"),
      '{ "readOnly": ["nope.ts"] }',
    );

    assert.throws(
      () => loadLessons(dir),
      /first\/hello: no shared file nope.ts/,
    );
    rmSync(dir, { recursive: true });
  });

  it("refuses a page folder without a number and a slug", () => {
    const dir = copy();

    cpSync(join(dir, "01-first", "01-hello"), join(dir, "01-first", "hello"), {
      recursive: true,
    });

    assert.throws(() => loadLessons(dir), /a page folder is <nn>-<slug>/);
    rmSync(dir, { recursive: true });
  });
});
