/**
 * Tests for the working tree tarball: paths of every length must extract
 * where they came from.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildWorkingTreeTarball } from "./tarball.ts";

describe("buildWorkingTreeTarball", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ci-tarball-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("extracts long nested paths at the right place with system tar", async () => {
    const source = join(root, "source");
    const dest = join(root, "dest");

    mkdirSync(source);
    mkdirSync(dest);

    execFileSync("git", ["init", "-q"], { cwd: source });

    const paths = [
      "short.txt",
      // Over 100 bytes, fits ustar name + prefix.
      `${"a".repeat(40)}/${"b".repeat(40)}/${"c".repeat(40)}/file.txt`,
      // No `/` split fits, so this needs a PAX header.
      `${"d".repeat(200)}/file.txt`,
      `${"e".repeat(90)}/${"f".repeat(90)}/${"g".repeat(90)}/file.txt`,
    ];

    for (const path of paths) {
      const absolute = join(source, path);

      mkdirSync(join(absolute, ".."), { recursive: true });

      writeFileSync(absolute, `contents of ${path.length}`);
    }

    writeFileSync(
      join(root, "work.tar"),
      await buildWorkingTreeTarball(source),
    );

    execFileSync("tar", ["-xf", join(root, "work.tar"), "-C", dest]);

    for (const path of paths) {
      expect(readFileSync(join(dest, path), "utf8")).toBe(
        `contents of ${path.length}`,
      );
    }
  });

  test("symlinks are archived as links and their targets are never read", async () => {
    const source = join(root, "source");
    const dest = join(root, "dest");
    const outside = join(root, "outside-secret.txt");
    const longTarget = `../${"t".repeat(150)}`;

    mkdirSync(source);
    mkdirSync(dest);

    writeFileSync(outside, "TOP-SECRET-CONTENTS");
    writeFileSync(join(source, "real.txt"), "real");

    symlinkSync(outside, join(source, "escape"));
    symlinkSync("real.txt", join(source, "inside"));
    symlinkSync(longTarget, join(source, "long"));

    execFileSync("git", ["init", "-q"], { cwd: source });

    const tarball = await buildWorkingTreeTarball(source);

    expect(Buffer.from(tarball).toString("latin1")).not.toContain(
      "TOP-SECRET-CONTENTS",
    );

    writeFileSync(join(root, "work.tar"), tarball);

    execFileSync("tar", ["-xf", join(root, "work.tar"), "-C", dest]);

    expect(lstatSync(join(dest, "escape")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, "escape"))).toBe(outside);
    expect(readlinkSync(join(dest, "inside"))).toBe("real.txt");
    expect(readlinkSync(join(dest, "long"))).toBe(longTarget);
    expect(readFileSync(join(dest, "inside"), "utf8")).toBe("real");
  });

  test("extracting over an existing directory updates files and keeps the rest", async () => {
    const source = join(root, "source");
    const dest = join(root, "dest");

    mkdirSync(source);
    mkdirSync(join(dest, "node_modules"), { recursive: true });

    execFileSync("git", ["init", "-q"], { cwd: source });

    writeFileSync(join(source, "a.txt"), "old");
    writeFileSync(join(source, "gone.txt"), "old");
    writeFileSync(join(source, "same.txt"), "same");

    writeFileSync(
      join(root, "first.tar"),
      await buildWorkingTreeTarball(source),
    );

    execFileSync("tar", ["-xf", join(root, "first.tar"), "-C", dest]);

    writeFileSync(join(dest, "node_modules", "x"), "installed");

    writeFileSync(join(source, "a.txt"), "new");
    writeFileSync(join(source, "added.txt"), "added");

    rmSync(join(source, "gone.txt"));

    writeFileSync(
      join(root, "second.tar"),
      await buildWorkingTreeTarball(source),
    );

    execFileSync("tar", ["-xf", join(root, "second.tar"), "-C", dest]);

    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(dest, "added.txt"), "utf8")).toBe("added");
    expect(readFileSync(join(dest, "same.txt"), "utf8")).toBe("same");
    expect(readFileSync(join(dest, "node_modules", "x"), "utf8")).toBe(
      "installed",
    );

    // Known limitation: a file deleted locally since the first upload lingers.
    expect(readFileSync(join(dest, "gone.txt"), "utf8")).toBe("old");
  });
});
