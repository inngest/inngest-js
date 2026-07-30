import { context, type TracerProvider, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const unwrapProvider = (): object => {
  const provider = trace.getTracerProvider();
  if ("getDelegate" in provider && typeof provider.getDelegate === "function") {
    return provider.getDelegate();
  }

  return provider;
};

describe("provider marker", () => {
  beforeEach(() => {
    vi.resetModules();
    trace.disable();
    context.disable();
  });

  afterEach(() => {
    trace.disable();
    context.disable();
  });

  test("uses the shared global symbol key", async () => {
    const { providerMarker } = await import("../src/instrument.ts");

    expect(providerMarker).toBe(Symbol.for("inngest.otel.provider"));
  });

  test("marks providers it creates", async () => {
    const { instrumentTracing, providerMarker } = await import(
      "../src/instrument.ts"
    );

    instrumentTracing();

    const provider = unwrapProvider();
    expect((provider as Record<symbol, unknown>)[providerMarker]).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(provider, providerMarker)?.enumerable,
    ).toBe(false);
  });

  test("does not mark pre-existing providers", async () => {
    const existingProvider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(
      existingProvider as unknown as TracerProvider,
    );

    const { instrumentTracing, providerMarker } = await import(
      "../src/instrument.ts"
    );

    instrumentTracing();

    expect(
      (existingProvider as unknown as Record<symbol, unknown>)[providerMarker],
    ).toBeUndefined();
  });
});
