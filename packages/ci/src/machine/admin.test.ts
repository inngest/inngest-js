/**
 * Tests of the Sandboxes API helper cleanup shares: machine destroys by ID that
 * tolerate what is already gone.
 *
 * @module
 */

import type { Inngest } from "inngest";
import { describe, expect, test } from "vitest";
import { destroySandboxes } from "./admin.ts";

describe("destroySandboxes", () => {
  test("destroys what it holds, skips what is gone, and throws what else fails", async () => {
    const destroyed: string[] = [];

    const get = async (id: string) => {
      if (id === "gone") {
        throw Object.assign(new Error("gone"), { code: "sandbox_not_found" });
      }

      if (id === "stuck") {
        throw new Error("refused");
      }

      return {
        destroy: async () => {
          destroyed.push(id);
        },
      };
    };

    const client = { sandboxes: { get } } as unknown as Inngest.Any;

    await expect(
      destroySandboxes(client, ["one", "gone", "two"]),
    ).resolves.toEqual({ destroyed: 2 });

    expect(destroyed).toEqual(["one", "two"]);

    await expect(destroySandboxes(client, ["stuck"])).rejects.toThrow(
      "refused",
    );
  });
});
