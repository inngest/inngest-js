/**
 * @module
 * Tests for `skills.folder`: reading `SKILL.md` skills from a folder shipped
 * with the app.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { collectSkills, skills } from "./skills.ts";

describe("skills.folder", () => {
  let root: string;

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("reads name, description and body from SKILL.md, and keeps the files beside it", () => {
    write(
      "refund-policy/SKILL.md",
      '---\nname: refund-policy\ndescription: "How to decide a refund"\n---\n\nRefund within 30 days.\n',
    );
    write("refund-policy/check.py", "print('ok')\n");
    write("refund-policy/data/limits.txt", "30\n");

    const [skill] = skills.folder(root).skills;

    expect(skill?.name).toBe("refund-policy");
    expect(skill?.description).toBe("How to decide a refund");
    expect(skill?.body.trim()).toBe("Refund within 30 days.");
    expect(skill?.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "check.py",
      "data/limits.txt",
    ]);
  });

  test("a SKILL.md with no name or description is an error", () => {
    write("bad/SKILL.md", "---\nname: bad\n---\nbody\n");

    expect(() => skills.folder(root)).toThrow(/description/);
  });

  test("a name that could leave its folder is an error", () => {
    write("bad/SKILL.md", "---\nname: ../x\ndescription: d\n---\nbody\n");

    expect(() => skills.folder(root)).toThrow(/name/);
  });

  test("two skills with one name are an error at definition time", () => {
    write("a/SKILL.md", "---\nname: same\ndescription: one\n---\nA\n");
    write("b/SKILL.md", "---\nname: same\ndescription: two\n---\nB\n");

    expect(() => collectSkills([skills.folder(root)])).toThrow(/same/);
  });
});
