import { trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { InngestSpanProcessor } from "./processor.ts";
import { extendProvider } from "./util.ts";

// Simulate a provider with `addSpanProcessor` (like NodeTracerProvider or
// OTel SDK v1 BasicTracerProvider — v2 removed this method from the class).
function createProviderWithAddSpanProcessor() {
  const provider = new BasicTracerProvider();
  const addSpanProcessor = vi.fn();
  // biome-ignore lint/suspicious/noExplicitAny: test helper to simulate NodeTracerProvider
  (provider as any).addSpanProcessor = addSpanProcessor;
  return { provider, addSpanProcessor };
}

describe("extendProvider", () => {
  afterEach(() => {
    trace.disable();
  });

  test("should succeed when a provider with addSpanProcessor is registered globally", () => {
    const { provider } = createProviderWithAddSpanProcessor();
    trace.setGlobalTracerProvider(provider);

    const result = extendProvider("auto");

    expect(result.success).toBe(true);
    expect((result as { processor: unknown }).processor).toBeInstanceOf(
      InngestSpanProcessor,
    );
  });

  test("should succeed with behaviour 'extendProvider'", () => {
    const { provider } = createProviderWithAddSpanProcessor();
    trace.setGlobalTracerProvider(provider);

    const result = extendProvider("extendProvider");

    expect(result.success).toBe(true);
  });

  test("should return success: false when no provider is registered", () => {
    trace.disable();

    const result = extendProvider("auto");

    expect(result.success).toBe(false);
  });

  test("should warn and return success: false with behaviour 'extendProvider' when no real provider", () => {
    trace.disable();

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const result = extendProvider("extendProvider", mockLogger);

    expect(result.success).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test("should call addSpanProcessor on the underlying provider", () => {
    const { provider, addSpanProcessor } = createProviderWithAddSpanProcessor();
    trace.setGlobalTracerProvider(provider);

    const result = extendProvider("auto");

    expect(result.success).toBe(true);
    expect(addSpanProcessor).toHaveBeenCalledTimes(1);
    expect(addSpanProcessor).toHaveBeenCalledWith(
      expect.any(InngestSpanProcessor),
    );
  });
});
