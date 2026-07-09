import { afterEach, describe, expect, test } from "vitest";
import { createStream } from "./stream.ts";

/**
 * When the consumer cancels the stream (client or proxy disconnect), the
 * controller closes and later `enqueue`s throw `Invalid state: Controller is
 * already closed`. Unguarded, that crashed the process from the heartbeat timer
 * and rejected from `finalize`; these tests keep both paths from regressing.
 */
describe("createStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("heartbeat does not throw after the consumer cancels the stream", async () => {
    vi.useFakeTimers();

    const { stream } = await createStream();

    const reader = stream.getReader();
    await reader.cancel();

    // A throw here used to escape the `setInterval` callback and crash the process
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
  });

  test("finalize does not reject after the consumer cancels the stream", async () => {
    const { stream, finalize } = await createStream();

    const reader = stream.getReader();
    await reader.cancel();

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);

    // Temporarily own the unhandledRejection channel so the assertion is
    // explicit and a pre-fix rejection doesn't leak into the rest of the suite.
    const existing = process.listeners("unhandledRejection");
    for (const l of existing) {
      process.off("unhandledRejection", l);
    }
    process.on("unhandledRejection", onRejection);

    try {
      finalize({ status: 201, body: "ok" });

      // Yield a macrotask so the finalize chain settles and Node's
      // unhandled-rejection detection runs (a microtask tick is not enough).
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onRejection);
      for (const l of existing) {
        process.on("unhandledRejection", l as (reason: unknown) => void);
      }
    }

    expect(rejections).toEqual([]);
  });
});
