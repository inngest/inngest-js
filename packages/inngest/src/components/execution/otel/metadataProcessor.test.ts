import { type Attributes, context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { AIMetadata } from "./aiExtractor.ts";
import { InngestMetadataSpanProcessor } from "./metadataProcessor.ts";

const TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

describe("InngestMetadataSpanProcessor", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  function setup() {
    const processor = new InngestMetadataSpanProcessor();
    const provider = new BasicTracerProvider();
    // Mirror production wiring: register the provider globally and let the
    // processor attach itself, which flips its `#attached` latch. Injecting via
    // the constructor would leave the processor unattached, so
    // `declareStartingSpan` would no-op.
    trace.setGlobalTracerProvider(provider);
    processor.attach();
    const tracer = provider.getTracer("test");
    return { processor, tracer };
  }

  function attrsOf(span: unknown): Record<string, unknown> {
    return (span as { attributes: Record<string, unknown> }).attributes;
  }

  /** Start a child span under `root`, optionally with attributes, and end it. */
  function endChild(
    tracer: ReturnType<BasicTracerProvider["getTracer"]>,
    root: ReturnType<ReturnType<BasicTracerProvider["getTracer"]>["startSpan"]>,
    name: string,
    attributes?: Attributes,
  ) {
    const child = tracer.startSpan(
      name,
      attributes ? { attributes } : undefined,
      trace.setSpan(context.active(), root),
    );
    child.end();
  }

  /**
   * Declare a run root on the processor with a sink that collects every
   * pushed {@link AIMetadata} value.
   */
  function declaredRoot(
    processor: InngestMetadataSpanProcessor,
    tracer: ReturnType<BasicTracerProvider["getTracer"]>,
  ) {
    const pushed: AIMetadata[] = [];
    const root = tracer.startSpan("inngest.execution");
    processor.declareStartingSpan({
      span: root,
      traceparent: TRACEPARENT,
      onAIMetadata: (metadata) => pushed.push(metadata),
    });
    return { root, pushed };
  }

  test("is read-only: leaves tracked span attributes exactly as set", () => {
    const { processor, tracer } = setup();
    const { root } = declaredRoot(processor, tracer);

    // An AI span exercises the processor's read path; assert it neither adds
    // nor removes attributes relative to what the caller set.
    const aiInput = {
      "llm.model_name": "gpt-4.1-nano",
      "llm.token_count.prompt": 42,
    };
    const aiChild = tracer.startSpan(
      "llm",
      { attributes: aiInput },
      trace.setSpan(context.active(), root),
    );
    aiChild.end();

    expect(attrsOf(aiChild)).toEqual(aiInput);
    expect(attrsOf(root)).toEqual({});
  });

  test("pushes AI metadata to the sink when a tracked span ends", () => {
    const { processor, tracer } = setup();
    const { root, pushed } = declaredRoot(processor, tracer);

    endChild(tracer, root, "llm", {
      "llm.model_name": "gpt-4.1-nano",
      "llm.token_count.prompt": 42,
    });

    expect(pushed).toEqual([
      { "llm.model_name": "gpt-4.1-nano", "llm.token_count.prompt": 42 },
    ]);
  });

  test("pushes once per span; aggregation is the sink owner's job", () => {
    const { processor, tracer } = setup();
    const { root, pushed } = declaredRoot(processor, tracer);

    endChild(tracer, root, "llm-1", {
      "llm.model_name": "gpt-4.1-nano",
      "llm.token_count.prompt": 10,
    });
    endChild(tracer, root, "llm-2", {
      "llm.model_name": "gpt-4.1-mini",
      "llm.token_count.prompt": 5,
    });

    expect(pushed).toEqual([
      { "llm.model_name": "gpt-4.1-nano", "llm.token_count.prompt": 10 },
      { "llm.model_name": "gpt-4.1-mini", "llm.token_count.prompt": 5 },
    ]);
  });

  test("does not call the sink for tracked spans with no AI attributes", () => {
    const { processor, tracer } = setup();
    const { root, pushed } = declaredRoot(processor, tracer);

    endChild(tracer, root, "plain");

    expect(pushed).toEqual([]);
  });

  test("tracks descendants transitively, not just direct children", () => {
    const { processor, tracer } = setup();
    const { root, pushed } = declaredRoot(processor, tracer);

    const mid = tracer.startSpan(
      "mid",
      undefined,
      trace.setSpan(context.active(), root),
    );
    endChild(tracer, mid, "llm", {
      "llm.model_name": "gpt-4.1-nano",
      "llm.token_count.prompt": 7,
    });
    mid.end();

    expect(pushed).toEqual([
      { "llm.model_name": "gpt-4.1-nano", "llm.token_count.prompt": 7 },
    ]);
  });

  test("ignores spans that are not part of a declared run", () => {
    const { processor, tracer } = setup();
    const { pushed } = declaredRoot(processor, tracer);

    // A separate root that was never declared: neither it nor its children
    // are tracked, so their AI attributes are never pushed anywhere.
    const orphan = tracer.startSpan("orphan");
    endChild(tracer, orphan, "orphan-child", {
      "llm.model_name": "gpt-4.1-nano",
      "llm.token_count.prompt": 99,
    });
    orphan.end();

    expect(pushed).toEqual([]);
  });

  /** Read a provider's internal span processor list, as the attach does. */
  function processorsOf(provider: BasicTracerProvider): unknown[] {
    const active = (provider as unknown as Record<string, unknown>)
      ._activeSpanProcessor as Record<string, unknown>;
    return active._spanProcessors as unknown[];
  }

  test("attach is a no-op when no global provider is registered", () => {
    const processor = new InngestMetadataSpanProcessor();

    // No provider registered → the proxy delegates to a noop provider, which
    // cannot be extended. attach must not throw.
    expect(() => processor.attach()).not.toThrow();
  });

  test("attach attaches to the pre-existing global provider exactly once", () => {
    const processor = new InngestMetadataSpanProcessor();
    const provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);

    processor.attach();
    // Repeat calls are latched and must not re-attach (which would
    // double-process every span and double-count tokens).
    processor.attach();

    expect(processorsOf(provider).filter((p) => p === processor)).toHaveLength(
      1,
    );
  });

  test("attach can succeed on a later call once a provider appears", () => {
    const processor = new InngestMetadataSpanProcessor();

    // First call: no provider yet, so nothing attaches.
    processor.attach();

    const provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);

    // A later call (e.g. another client constructed after the provider was
    // set up) attaches successfully.
    processor.attach();

    expect(processorsOf(provider).filter((p) => p === processor)).toHaveLength(
      1,
    );
  });
});
