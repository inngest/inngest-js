/**
 * Tests for the command line: known options, and unknown ones as matrix axes.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { parseCliArgs } from "./args.ts";
import { SetupError } from "./setupError.ts";

describe("parseCliArgs", () => {
  test("reads a target and options", () => {
    const args = parseCliArgs([
      "pr",
      "--event",
      "push",
      "--data",
      '{"a":1}',
      "--no-interactive",
    ]);

    expect(args).toMatchObject({
      name: "pr",
      event: "push",
      data: '{"a":1}',
      noInteractive: true,
      combo: {},
    });
  });

  test("keeps unknown options as matrix axes", () => {
    const args = parseCliArgs(["compat", "--os", "linux", "--node=22"]);

    expect(args.name).toBe("compat");
    expect(args.combo).toEqual({ os: "linux", node: "22" });
  });

  test("reads --job and --help", () => {
    expect(parseCliArgs(["--job", "lint", "-h"])).toMatchObject({
      job: "lint",
      help: true,
    });
  });

  test("rejects a second positional and a missing axis value", () => {
    expect(() => parseCliArgs(["a", "b"])).toThrow(SetupError);
    expect(() => parseCliArgs(["a", "--os"])).toThrow("--os needs a value");
  });
});
