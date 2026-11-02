/**
 * @module
 * Tests for `startability`: the check `start_agent` makes just before it
 * starts an agent, and that the function behind an address is neither paused,
 * nor archived, nor missing.
 */
import type { Inngest } from "../../../components/Inngest.ts";
import { startability } from "./functions.ts";

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
