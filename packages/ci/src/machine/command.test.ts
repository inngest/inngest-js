/**
 * Tests of how a sandbox process's output chunks are decoded into text:
 * a multi-byte UTF-8 character split across two chunks of one stream must
 * survive, the two streams must not corrupt each other when their chunks
 * interleave, and output that genuinely ends inside a character keeps the
 * replacement character it has always produced.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { decodeChunks } from "./command.ts";

const bytes = (text: string): Uint8Array => {
  return new TextEncoder().encode(text);
};

describe("decodeChunks", () => {
  test("joins a multi-byte character split across two chunks", () => {
    const rocket = bytes("🚀");

    const chunks = [
      { stream: "STDOUT", data: rocket.subarray(0, 2) },
      { stream: "STDOUT", data: rocket.subarray(2) },
    ];

    expect(decodeChunks({ chunks })).toEqual({
      stdout: "🚀",
      stderr: "",
      merged: "🚀",
    });
  });

  test("decodes each stream independently when chunks interleave", () => {
    const euro = bytes("€");
    const pi = bytes("π");

    const chunks = [
      { stream: "STDOUT", data: euro.subarray(0, 1) },
      { stream: "STDERR", data: pi.subarray(0, 1) },
      { stream: "STDOUT", data: euro.subarray(1) },
      { stream: "STDERR", data: pi.subarray(1) },
    ];

    expect(decodeChunks({ chunks })).toEqual({
      stdout: "€",
      stderr: "π",
      merged: "€π",
    });
  });

  test("passes string data through unchanged", () => {
    const chunks = [
      { stream: "STDOUT", data: "hello " },
      { stream: "STDERR", data: "warn\n" },
      { stream: "STDOUT", data: bytes("world") },
    ];

    expect(decodeChunks({ chunks })).toEqual({
      stdout: "hello world",
      stderr: "warn\n",
      merged: "hello warn\nworld",
    });
  });

  test("replaces a character the output ends inside", () => {
    const chunks = [{ stream: "STDERR", data: bytes("€").subarray(0, 2) }];

    expect(decodeChunks({ chunks })).toEqual({
      stdout: "",
      stderr: "�",
      merged: "�",
    });
  });

  test("handles missing and empty output", () => {
    expect(decodeChunks({})).toEqual({ stdout: "", stderr: "", merged: "" });

    expect(decodeChunks({ chunks: [] })).toEqual({
      stdout: "",
      stderr: "",
      merged: "",
    });
  });
});
