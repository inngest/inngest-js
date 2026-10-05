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
  readFileSync,
  rmSync,
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
});
