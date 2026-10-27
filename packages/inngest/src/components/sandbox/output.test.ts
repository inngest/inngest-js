/**
 * @module
 * Exec and process output is readable text in step results when it is valid
 * UTF-8, base64 when it is not, and steps memoized as base64 still replay.
 */

import { describe, expect, test, vi } from "vitest";
import { createDurableSandboxFacade, execOperationResult } from "./durable.ts";
import type { SandboxRawTool } from "./protocol.ts";
import { sandboxRef } from "./test-helpers.ts";
import { decodeOutputChunk, encodeBase64, encodeOutput } from "./validation.ts";

const bytes = (text: string): Uint8Array => {
  return new TextEncoder().encode(text);
};

const exec = (stdout: Uint8Array, stderr: Uint8Array) => {
  return execOperationResult({ stdout, stderr, exitCode: 0 });
};

describe("exec output in a step result", () => {
  test("is text when both streams are UTF-8", () => {
    expect(exec(bytes("hello π 🚀\n"), bytes("warn\n"))).toMatchObject({
      result: { stdout: "hello π 🚀\n", stderr: "warn\n", encoding: "utf8" },
    });
  });

  test.each([
    {
      name: "stdout is binary",
      stdout: new Uint8Array([0xff, 0]),
      stderr: "ok",
    },
    {
      name: "stderr is binary",
      stdout: bytes("ok"),
      stderr: new Uint8Array([0xe2, 0x82]),
    },
    {
      name: "control characters would escape larger than base64",
      stdout: new Uint8Array(64),
      stderr: "",
    },
  ])("is base64 for both streams when $name", ({ stdout, stderr }) => {
    const stderrBytes = typeof stderr === "string" ? bytes(stderr) : stderr;
    const { result } = exec(stdout, stderrBytes) as {
      result: { stdout: string; stderr: string; encoding: string };
    };

    expect(result).toMatchObject({
      stdout: encodeBase64(stdout),
      stderr: encodeBase64(stderrBytes),
      encoding: "base64",
    });
  });

  test("only a cut stream drops its leading continuation bytes", () => {
    const orphan = new Uint8Array([0x80, 0x41]);

    expect(
      encodeOutput([orphan, orphan], { truncated: [true, false] }),
    ).toEqual({
      encoding: "base64",
      values: [encodeBase64(orphan), encodeBase64(orphan)],
    });
  });

  test("text is chosen by encoded JSON bytes, not string length", () => {
    const mixed = new Uint8Array([
      ...bytes("漢".repeat(30)),
      ...new Uint8Array(15),
    ]);

    expect(encodeOutput([mixed]).encoding).toBe("base64");
  });

  test("a tail cut inside a character stays text", () => {
    const euro = bytes("€");
    const tail = new Uint8Array([...euro.subarray(1), ...bytes("tail")]);

    expect(encodeOutput([tail], { truncated: [true] })).toEqual({
      encoding: "utf8",
      values: ["tail"],
    });
    expect(encodeOutput([tail]).encoding).toBe("base64");
  });
});

describe("replaying a memoized exec step", () => {
  test.each([
    {
      name: "written as base64 by an older SDK",
      stdout: encodeBase64(bytes("out π\n")),
      stderr: encodeBase64(bytes("err\n")),
      encoding: "base64",
    },
    {
      name: "written as text",
      stdout: "out π\n",
      stderr: "err\n",
      encoding: "utf8",
    },
  ])(
    "returns the same output when $name",
    async ({ stdout, stderr, encoding }) => {
      const rawTool: SandboxRawTool = vi.fn(async () => {
        return {
          protocolVersion: 1,
          action: "exec",
          result: {
            stdout,
            stderr,
            encoding,
            exitCode: 3,
            output: { truncated: false },
          },
        };
      });
      const sandbox = createDurableSandboxFacade(sandboxRef, () => {
        return rawTool;
      });

      await expect(sandbox.commands.run("exec", "true")).resolves.toEqual({
        stdout: "out π\n",
        stderr: "err\n",
        exitCode: 3,
        output: { truncated: false },
      });
    },
  );
});

describe("process output chunks", () => {
  test.each([
    { data: "hi π", encoding: "utf8" },
    { data: encodeBase64(bytes("hi π")), encoding: "base64" },
  ])("decode from $encoding", ({ data, encoding }) => {
    expect(
      decodeOutputChunk({ stream: "STDOUT", data, encoding }).data,
    ).toEqual(bytes("hi π"));
  });

  test("a leading byte order mark survives the round trip", () => {
    const data = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    const { encoding, values } = encodeOutput([data]);

    expect(
      decodeOutputChunk({ stream: "STDOUT", data: values[0], encoding }).data,
    ).toEqual(data);
  });

  test("a chunk split inside a character falls back to base64", () => {
    expect(encodeOutput([bytes("€").subarray(0, 2)]).encoding).toBe("base64");
  });
});
