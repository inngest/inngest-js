/**
 * Tests for the `image` helpers and how Create resolves `from` to the wire
 * `image` string.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { image } from "./image.ts";
import { normalizeSandboxCreateOptions } from "./validation.ts";

const base = { name: "box", vcpu: 1, memoryMb: 512 };

describe("sandbox image helpers", () => {
  test.each([
    [image.inngest("base"), "inngest/base"],
    [image.custom("my-image"), "my-image"],
    [image.custom("my-image:v1"), "my-image:v1"],
    [
      image.custom(`my-image@sha256:${"a".repeat(64)}`),
      `my-image@sha256:${"a".repeat(64)}`,
    ],
  ])("resolves from to the image string: %j", (from, expected) => {
    const options = normalizeSandboxCreateOptions({ ...base, from });

    expect(options).toMatchObject({ image: expected });
    expect(options).not.toHaveProperty("from");
  });

  test("omitting from keeps the default", () => {
    expect(normalizeSandboxCreateOptions(base)).not.toHaveProperty("image");
  });

  test.each([
    ["from and image together", { from: image.inngest("base"), image: "x" }],
    ["an invalid custom ref", { from: image.custom("My Image") }],
    ["the reserved default alias", { from: image.custom("default") }],
    ["a plain string", { from: "inngest/base" }],
    [
      "a snapshot clone",
      {
        name: "c",
        snapshotId: "00000000-0000-4000-8000-000000000000",
        from: image.inngest("base"),
      },
    ],
  ])("rejects %s", (_label, options) => {
    expect(() => {
      return normalizeSandboxCreateOptions({ ...base, ...options } as never);
    }).toThrow();
  });
});
