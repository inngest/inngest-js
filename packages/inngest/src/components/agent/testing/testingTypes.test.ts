/**
 * @module
 * Type tests for the testing entry: `withKeys` keeps the request and reply
 * types of the handle it wraps and returns the keys from `state()`.
 */
import { expectTypeOf } from "vitest";
import type { ThreadHandle } from "../thread.ts";
import { type ThreadHandleWithKeys, withKeys } from "./threads.ts";

describe("testing types", () => {
  test("withKeys keeps the handle's request and reply types", () => {
    const check = (handle: ThreadHandle<{ q: string }, { a: number }>) => {
      const wrapped = withKeys(handle);

      expectTypeOf(wrapped).toEqualTypeOf<
        ThreadHandleWithKeys<{ q: string }, { a: number }>
      >();
      expectTypeOf(wrapped.state).returns.resolves.toEqualTypeOf<
        Record<string, unknown>
      >();
      expectTypeOf(wrapped.request<{ a: 1 }>)
        .parameter(0)
        .toEqualTypeOf<{
          q: string;
        }>();
    };

    expect(check).toBeTypeOf("function");
  });
});
