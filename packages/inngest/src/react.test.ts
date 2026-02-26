import { RealtimeState, useRealtime } from "./react.ts";

describe("react exports", () => {
  test("exports the realtime hook and state enum", () => {
    expect(typeof useRealtime).toBe("function");
    expect(RealtimeState.Active).toBe("active");
    expect(RealtimeState.Connecting).toBe("connecting");
  });

  test("useRealtime return type includes spec-style fields", () => {
    type HookResult = ReturnType<typeof useRealtime>;

    expectTypeOf<HookResult["status"]>().toEqualTypeOf<
      "idle" | "connecting" | "open" | "closed" | "error"
    >();
    expectTypeOf<HookResult["runStatus"]>().toEqualTypeOf<
      "unknown" | "running" | "completed" | "failed" | "cancelled"
    >();
    expectTypeOf<HookResult["history"]>().toBeArray();
    expectTypeOf<HookResult["reset"]>().toBeFunction();
    expectTypeOf<HookResult["latest"]>().not.toBeAny();
  });
});
