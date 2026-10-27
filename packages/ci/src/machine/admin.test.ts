/**
 * Tests of the Sandboxes API helpers cleanup shares: snapshot and machine
 * deletes by ID that tolerate what is already gone.
 *
 * @module
 */

import type { Inngest } from "inngest";
import { describe, expect, test, vi } from "vitest";
import { deleteSnapshots, destroySandboxes } from "./admin.ts";

const notFound = Object.assign(new Error("gone"), {
  code: "sandbox_snapshot_not_found",
});

describe("deleteSnapshots", () => {
  test("counts what it deletes, skips what is gone, and reports what fails", async () => {
    const deleted: string[] = [];

    const get = async (id: string) => {
      if (id === "gone") {
        throw notFound;
      }

      if (id === "stuck") {
        throw new Error("refused");
      }

      return {
        delete: async () => {
          deleted.push(id);
        },
      };
    };

    const client = {
      sandboxes: { snapshots: { get } },
    } as unknown as Inngest.Any;
    const onFailure = vi.fn();

    const result = await deleteSnapshots(
      client,
      ["a", "gone", "stuck", "b"],
      onFailure,
    );

    expect(result).toEqual({ deleted: ["a", "b"], failed: ["stuck"] });
    expect(deleted).toEqual(["a", "b"]);
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

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
