/**
 * @module
 * Type tests for the testing entry: `withKeys` returns the keys from
 * `state()`.
 */
import { expectTypeOf } from "vitest";
import type { ThreadHandle } from "../thread.ts";
import { type ThreadHandleWithKeys, withKeys } from "./threads.ts";

describe("testing types", () => {
  test("withKeys returns the keys from state()", () => {
    const check = (handle: ThreadHandle) => {
      const wrapped = withKeys(handle);

      expectTypeOf(wrapped).toEqualTypeOf<ThreadHandleWithKeys>();
      expectTypeOf(wrapped.state).returns.resolves.toEqualTypeOf<
        Record<string, unknown>
      >();
    };

    expect(check).toBeTypeOf("function");
  });
});
