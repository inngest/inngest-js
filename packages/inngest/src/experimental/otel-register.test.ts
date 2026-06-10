const { register } = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("node:module", () => ({ register }));

describe("otel-register", () => {
  test("registers the OpenTelemetry ESM loader hook", async () => {
    await import("./otel-register.ts");

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(
      "@opentelemetry/instrumentation/hook.mjs",
      { parentURL: expect.stringContaining("otel-register") },
    );
  });
});
