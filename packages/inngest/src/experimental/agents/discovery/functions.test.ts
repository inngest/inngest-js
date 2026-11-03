/**
 * @module
 * Tests for `startability`: the check `start_agent` makes just before it
 * starts an agent, and that the function behind an address is neither paused,
 * nor archived, nor missing.
 */
import type { Inngest } from "../../../components/Inngest.ts";
import { readAppFunctions, startability } from "./functions.ts";

const client = { id: "me" } as unknown as Inngest.Any;

const reading = (functions: [string, boolean, boolean][]) => {
  return async () => {
    return new Map(
      functions.map(([id, paused, archived]) => {
        return [id, { paused, archived }] as const;
      }),
    );
  };
};

describe("startability", () => {
  test("a live function can be started", async () => {
    expect(
      await startability(
        client,
        "other/docs",
        reading([["docs", false, false]]),
      ),
    ).toEqual({ ok: true });
  });

  test("a paused function is refused with a reason the model can read", async () => {
    const result = await startability(
      client,
      "other/docs",
      reading([["docs", true, false]]),
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("paused"),
    });
  });

  test("an archived function is refused with a reason the model can read", async () => {
    const result = await startability(
      client,
      "other/docs",
      reading([["docs", false, true]]),
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("archived"),
    });
  });

  test("a function the app does not list is refused as gone", async () => {
    const result = await startability(
      client,
      "other/docs",
      reading([["other-fn", false, false]]),
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("no longer exists"),
    });
  });

  test("asks about the app of the address", async () => {
    const read = vi.fn(reading([["docs", false, false]]));

    await startability(client, "other/docs", read);

    expect(read).toHaveBeenCalledWith("other");
  });
});

describe("readAppFunctions", () => {
  const pages = (sizes: number[]): { client: Inngest.Any; urls: string[] } => {
    const urls: string[] = [];
    const fetch = async (input: unknown) => {
      const url = new URL(String(input));

      urls.push(url.toString());

      const page = Number(url.searchParams.get("cursor") ?? "0");
      const data = Array.from({ length: sizes[page] ?? 0 }, (_, n) => {
        return { slug: `app-fn${page}_${n}`, is_paused: false };
      });
      const more = page + 1 < sizes.length;

      return new Response(
        JSON.stringify({
          data,
          page: { cursor: more ? String(page + 1) : null, hasMore: more },
        }),
        { status: 200 },
      );
    };

    return {
      urls,
      client: {
        id: "me",
        apiBaseUrl: "http://dev.test",
        signingKey: "signkey-test-12345678",
        headers: {},
        fetch,
      } as unknown as Inngest.Any,
    };
  };

  test("follows the cursor and finds a function on the second page", async () => {
    const { client: paged, urls } = pages([100, 3]);
    const found = await readAppFunctions(paged, "app");

    expect(found.size).toBe(103);
    expect(found.get("fn1_2")).toEqual({ paused: false, archived: false });
    expect(urls[0]).toContain("limit=100");
    expect(urls).toHaveLength(2);
  });

  test("fails with a clear error past the page cap instead of missing functions", async () => {
    const { client: endless } = pages(Array.from({ length: 80 }, () => 1));

    await expect(readAppFunctions(endless, "app")).rejects.toThrow(
      /more than 50 pages/,
    );
  });
});
