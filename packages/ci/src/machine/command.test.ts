/**
 * Tests of how captured command output is decoded into text: a multi-byte
 * character split between two chunks of a stream decodes whole, each stream
 * decodes on its own, and an unfinished character at the end of a stream is
 * flushed instead of dropped.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { decodeChunks } from "./command.ts";

const encoder = new TextEncoder();

// "é" is 2 bytes, "€" is 3, "😀" is 4.
const text = "caf\u00e9 \u20ac \u{1F600} done";

const bytes = encoder.encode(text);

/** Chunks of `data` cut at each of `cuts`, all on one stream. */
const split = (
  stream: "STDOUT" | "STDERR",
  data: Uint8Array,
  cuts: number[],
): Array<{ stream: string; data: Uint8Array }> => {
  const bounds = [0, ...cuts, data.length];

  return bounds.slice(1).map((end, i) => {
    return { stream, data: data.subarray(bounds[i], end) };
  });
};

describe("decodeChunks", () => {
  test("joins a multi-byte character split across stdout chunks", () => {
    // Cut inside "\u{1F600}" (4 bytes), after its first byte, mid-way, and
    // before its last byte.
    const start = bytes.indexOf(0xf0);

    for (const cut of [start + 1, start + 2, start + 3]) {
      const out = decodeChunks({ chunks: split("STDOUT", bytes, [cut]) });

      expect(out.stdout).toBe(text);
      expect(out.merged).toBe(text);
      expect(out.stderr).toBe("");
      expect(out.stdout).not.toContain("\uFFFD");
    }
  });

  test("joins a multi-byte character split across stderr chunks", () => {
    const start = bytes.indexOf(0xf0);
    const out = decodeChunks({ chunks: split("STDERR", bytes, [start + 2]) });

    expect(out.stderr).toBe(text);
    expect(out.merged).toBe(text);
    expect(out.stdout).toBe("");
    expect(out.stderr).not.toContain("\uFFFD");
  });

  test("decodes a character split at every byte boundary", () => {
    const cuts = Array.from(bytes, (_, i) => i).slice(1);

    for (const stream of ["STDOUT", "STDERR"] as const) {
      const out = decodeChunks({ chunks: split(stream, bytes, cuts) });
      const got = stream === "STDOUT" ? out.stdout : out.stderr;

      expect(got).toBe(text);
      expect(got).not.toContain("\uFFFD");
    }
  });

  test("keeps stdout and stderr apart when both split a character", () => {
    const out = encoder.encode("out \u{1F600}");
    const err = encoder.encode("err \u20ac");
    // The stderr chunks arrive in the middle of a split stdout character.
    const [out1, out2] = [out.subarray(0, 6), out.subarray(6)];
    const [err1, err2] = [err.subarray(0, 5), err.subarray(5)];

    const result = decodeChunks({
      chunks: [
        { stream: "STDOUT", data: out1 },
        { stream: "STDERR", data: err1 },
        { stream: "STDOUT", data: out2 },
        { stream: "STDERR", data: err2 },
      ],
    });

    expect(result.stdout).toBe("out \u{1F600}");
    expect(result.stderr).toBe("err \u20ac");
    expect(result.merged).not.toContain("\uFFFD");
    expect([...result.merged].sort()).toEqual(
      [..."out \u{1F600}err \u20ac"].sort(),
    );
  });

  test("flushes a character left unfinished when a stream ends", () => {
    // The stream ends after the first 2 bytes of a 4-byte character.
    const out = decodeChunks({
      chunks: [{ stream: "STDOUT", data: bytes.subarray(0, 12) }],
    });

    expect(out.stdout.startsWith("caf\u00e9 \u20ac ")).toBe(true);
    expect(out.stdout.endsWith("\uFFFD")).toBe(true);
    expect(out.merged).toBe(out.stdout);
  });

  test("passes text chunks through and handles no output", () => {
    expect(
      decodeChunks({
        chunks: [
          { stream: "STDOUT", data: "a\u00e9" },
          { stream: "STDERR", data: "b" },
        ],
      }),
    ).toEqual({ stdout: "a\u00e9", stderr: "b", merged: "a\u00e9b" });
    expect(decodeChunks({})).toEqual({ stdout: "", stderr: "", merged: "" });
  });
});
