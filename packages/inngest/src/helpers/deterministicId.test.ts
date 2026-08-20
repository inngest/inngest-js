import { describe, expect, test } from "vitest";
import { deterministicSpanID } from "./deterministicId.ts";

describe("deterministicSpanID", () => {
  // Expected values verified against Go's DeterministicSpanConfig().SpanID output.
  // These are the 3rd uint64 from chacha8rand (after 16 bytes of TraceID).
  const cases: [string, string][] = [
    ["test-seed-for-deterministic-span", "1f9f1fae2c8b51c4"],
    ["hello", "b5c2db5b06a644c5"],
    ["00000000-0000-0000-0000-000000000000", "51706347ebf6ef86"],
    // Real step seeds from DB-verified runs:
    ["86f7e437faa5a7fce15d1ddcb9eaeaea377667b8:0", "b017a66031df8079"],
    ["e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98:0", "a9a8b204ae8104ed"],
  ];

  test.each(cases)("seed %j → %s", (seed, expected) => {
    expect(deterministicSpanID(seed)).toBe(expected);
  });

  test("returns a 16-character hex string", () => {
    const id = deterministicSpanID("anything");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is deterministic across calls", () => {
    const a = deterministicSpanID("same-seed");
    const b = deterministicSpanID("same-seed");
    expect(a).toBe(b);
  });

  test("different seeds produce different IDs", () => {
    const a = deterministicSpanID("seed-a");
    const b = deterministicSpanID("seed-b");
    expect(a).not.toBe(b);
  });

  // Additional edge-case test vectors verified against Go's DeterministicSpanConfig.
  describe("edge cases", () => {
    const edgeCases: [string, string][] = [
      // Empty string seed
      ["", "dd9fc5ea353468a4"],
      // Very long seed (10000 'a' characters)
      ["a".repeat(10000), "955541c801f27c55"],
      // Null byte in seed
      ["hello\x00world", "8999f00b74c5d24d"],
      // UTF-8 multibyte characters (emoji)
      ["emoji-\u{1F600}-test", "1af63e4dd8245a1d"],
      // Special characters
      ["special!@#$%^&*()_+-=[]{}|;':\",./<>?", "b668435cd33ce0e1"],
    ];

    test.each(edgeCases)("seed %j → %s", (seed, expected) => {
      expect(deterministicSpanID(seed)).toBe(expected);
    });
  });

  // Production-format seeds: {sha1(stepName)}:{attempt}
  // These match the exact format used by the Go executor:
  //   fmt.Sprintf("%s:%d", gen.ID, runCtx.AttemptCount())
  // where gen.ID is the SHA-1 hex hash of the step name.
  describe("production-format seeds", () => {
    const productionCases: [string, string, string][] = [
      // [description, seed, expectedSpanID]
      [
        "step-1 attempt 0",
        "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa:0",
        "71d50495f5a32d76",
      ],
      [
        "step-1 attempt 1",
        "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa:1",
        "66ccae63f003f30c",
      ],
      [
        "step-1 attempt 2",
        "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa:2",
        "e488e4c433ddfb1b",
      ],
      [
        "my-step attempt 0",
        "8376129f22207d6e1acaa1c92de099dcb1ba24db:0",
        "979694712fbc957c",
      ],
      [
        "Send welcome email attempt 0",
        "d1eefd9de6e03a9f863a9b51d0140d6d0d58e609:0",
        "4d2647281790ca8f",
      ],
    ];

    test.each(productionCases)("%s → %s", (_desc, seed, expected) => {
      expect(deterministicSpanID(seed)).toBe(expected);
    });

    test("different attempts produce different span IDs", () => {
      const base = "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa";
      const ids = [0, 1, 2].map((attempt) =>
        deterministicSpanID(`${base}:${attempt}`),
      );
      expect(new Set(ids).size).toBe(3);
    });
  });
});
