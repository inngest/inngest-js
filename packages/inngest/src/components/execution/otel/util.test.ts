import { type Span, type TracerProvider, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { InngestSpanProcessor } from "./processor.ts";
import {
  createProvider,
  createProviderWithProcessor,
  extendProvider,
} from "./util.ts";

// Simulate a provider with `addSpanProcessor` (like NodeTracerProvider or
// OTel SDK v1 BasicTracerProvider — v2 removed this method from the class).
function createProviderWithAddSpanProcessor() {
  const provider = new BasicTracerProvider();
  const addSpanProcessor = vi.fn();
  // biome-ignore lint/suspicious/noExplicitAny: test helper to simulate NodeTracerProvider
  (provider as any).addSpanProcessor = addSpanProcessor;
  return { provider, addSpanProcessor };
}

const createNoopSpanProcessor = (): SpanProcessor => ({
  forceFlush: vi.fn(async () => undefined),
  onEnd: vi.fn((_span: ReadableSpan) => undefined),
  onStart: vi.fn((_span: Span) => undefined),
  shutdown: vi.fn(async () => undefined),
});

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

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = extendProvider("extendProvider");

    expect(result.success).toBe(false);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  test("should call addSpanProcessor on the underlying provider (v1 path)", () => {
    const { provider, addSpanProcessor } = createProviderWithAddSpanProcessor();
    trace.setGlobalTracerProvider(provider);

    const result = extendProvider("auto");

    expect(result.success).toBe(true);
    expect(addSpanProcessor).toHaveBeenCalledTimes(1);
    expect(addSpanProcessor).toHaveBeenCalledWith(
      expect.any(InngestSpanProcessor),
    );
  });

  test("should push into _activeSpanProcessor._spanProcessors when addSpanProcessor is missing (v2 path)", () => {
    // OTel SDK v2 BasicTracerProvider has no addSpanProcessor method.
    // Simulate by creating a plain provider (v2 BasicTracerProvider) which
    // exposes _activeSpanProcessor._spanProcessors at runtime.
    const provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);

    const result = extendProvider("auto");

    expect(result.success).toBe(true);
    expect((result as { processor: unknown }).processor).toBeInstanceOf(
      InngestSpanProcessor,
    );

    // Verify the processor was pushed into the internal array
    // biome-ignore lint/suspicious/noExplicitAny: accessing OTel internals for test assertion
    const spanProcessors = (provider as any)._activeSpanProcessor
      ._spanProcessors;
    expect(spanProcessors).toContainEqual(expect.any(InngestSpanProcessor));
  });

  test("should succeed with behaviour 'extendProvider' via v2 path", () => {
    const provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);

    const result = extendProvider("extendProvider");

    expect(result.success).toBe(true);
  });

  test("should warn and fail when provider has neither addSpanProcessor nor _activeSpanProcessor", () => {
    const mockProvider = {
      getTracer: vi.fn(),
    };
    trace.setGlobalTracerProvider(mockProvider as unknown as TracerProvider);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = extendProvider("extendProvider");

    expect(result.success).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unable to add InngestSpanProcessor"),
    );

    warnSpy.mockRestore();
  });

  test("should not warn on unknown provider when behaviour is 'auto'", () => {
    const mockProvider = {
      getTracer: vi.fn(),
    };
    trace.setGlobalTracerProvider(mockProvider as unknown as TracerProvider);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = extendProvider("auto");

    expect(result.success).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  test("should let Extended Traces provider creation win over AI metadata provider creation", async () => {
    trace.disable();

    const metadataProcessor = createNoopSpanProcessor();
    const metadataProviderCreation =
      createProviderWithProcessor(metadataProcessor);
    const extendedTracesProviderCreation = createProvider("auto", []);

    const [metadataResult, extendedTracesResult] = await Promise.all([
      metadataProviderCreation,
      extendedTracesProviderCreation,
    ]);

    expect(metadataResult.success).toBe(true);
    expect(extendedTracesResult.success).toBe(true);

    const provider = trace.getTracerProvider();
    let delegate: unknown = provider;
    if (
      "getDelegate" in provider &&
      typeof provider.getDelegate === "function"
    ) {
      delegate = provider.getDelegate();
    }

    // biome-ignore lint/suspicious/noExplicitAny: accessing OTel internals for test assertion
    const spanProcessors = (delegate as any)._activeSpanProcessor
      ._spanProcessors;

    expect(spanProcessors).toContain(metadataProcessor);
    expect(spanProcessors).toContainEqual(expect.any(InngestSpanProcessor));
  });
});
