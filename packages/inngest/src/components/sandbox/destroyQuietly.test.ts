/**
 * @module
 * Tests for `destroyQuietly`: when it ends the function's retries.
 */
import { describe, expect, test, vi } from "vitest";
import type { DurableSandbox } from "./types.ts";

const failFinally = vi.fn();

vi.mock("../execution/als.ts", () => {
  return {
    getAsyncCtxSync: () => {
      return { execution: { instance: { failFinally } } };
    },
  };
});

const { destroyQuietly } = await import("./group.ts");

const sandbox = () => {
  return { destroy: vi.fn(async () => {}) } as unknown as DurableSandbox;
};

describe("destroyQuietly", () => {
  test("ends the function's retries by default", async () => {
    failFinally.mockClear();

    await destroyQuietly(sandbox(), "box:destroy");

    expect(failFinally).toHaveBeenCalledTimes(1);
  });

  test("leaves them on when the run goes on past the destroy", async () => {
    failFinally.mockClear();
    const abort = vi.fn();

    await destroyQuietly(sandbox(), "box:destroy", { abort }, { final: false });

    expect(failFinally).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
