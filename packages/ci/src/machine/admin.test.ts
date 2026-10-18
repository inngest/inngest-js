/**
 * Tests of the Sandboxes API helpers cleanup shares: paged lists read as one
 * stream, and snapshot deletes that tolerate what is already gone.
 *
 * @module
 */

import type { Inngest } from "inngest";
import { describe, expect, test, vi } from "vitest";
import { deleteSnapshots, pages } from "./admin.ts";

const notFound = Object.assign(new Error("gone"), {
  code: "sandbox_snapshot_not_found",
});

describe("pages", () => {
  test("reads every page in order, passing the cursor on", async () => {
    const list = vi.fn(async (cursor?: string) => {
      return cursor === "next"
        ? { items: [3], page: { hasMore: false } }
        : { items: [1, 2], page: { hasMore: true, cursor: "next" } };
    });

    const read: number[] = [];

    for await (const item of pages(list)) {
      read.push(item);
    }

    expect(read).toEqual([1, 2, 3]);
    expect(list.mock.calls).toEqual([[undefined], ["next"]]);
  });
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
