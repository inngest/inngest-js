import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Logger } from "../../../middleware/logger.ts";
import type { StepWindowMetadata } from "./access.ts";
import {
  type AIMetadata,
  aggregate,
  extractAIMetadataFromAttributes,
} from "./aiExtractor.ts";
import { attachToGlobalProvider } from "./attach.ts";
import { InngestSpanProcessorBase } from "./baseProcessor.ts";

/**
 * A read-only OTel span processor that is independent of the
 * Extended Traces processor (`InngestSpanProcessor`).
 *
 * As each tracked span ends, it extracts {@link AIMetadata} (model + input
 * tokens) from the span's attributes and folds it into the currently-open step
 * window. When the step ends, the aggregated metadata is written back to the
 * step's metadata under the `inngest.ai` kind.
 *
 * NOTE on `step.ai.*` overlap: this processor only sees AI metadata emitted as
 * OTel span attributes by host-app instrumentation (traceloop / OpenInference /
 * Vercel-native telemetry) for LLM calls that end synchronously inside a step.
 * `step.ai.infer` has no host spans (the Inngest AI gateway runs server-side,
 * which extracts `inngest.ai` itself), so there is no overlap there. But
 * `step.ai.wrap` returning a Vercel AI SDK response is parsed server-side into
 * `inngest.ai` too — so a wrapped Vercel call with native OTel telemetry
 * enabled would be counted by both the server (from step output) and here (from
 * spans), and the two `inngest.ai` updates merge. We accept that double-count
 * risk for now; reconciling duplicate emitters for one step is a server-side
 * follow-up.
 */
export class InngestMetadataSpanProcessor extends InngestSpanProcessorBase {
  #logger: Logger;

  /**
   * Step windows: per-step accumulators for AI metadata extracted from spans
   * that end while a step's userland code is executing. Keyed by run root span
   * ID. A `null` value means the window is open but no AI metadata has been
   * seen yet.
   */
  #stepWindows = new Map<string, AIMetadata | null>();

  /**
   * Whether this processor has been attached to a global OTel provider. Guards
   * {@link ensureAttached} so a repeated call can never push the processor into
   * a provider's processor list twice (which would double-process every span
   * and double-count tokens).
   */
  #attached = false;

  constructor(logger: Logger) {
    super();
    this.#logger = logger;
  }

  /**
   * Idempotently attach this processor to the global OTel provider so it begins
   * receiving span lifecycle events. Returns whether it is attached.
   *
   * Attaching is extend-only (never creates a provider). It is attempted both at
   * client construction — which catches a provider set up first, e.g. a
   * `--require` OTel bootstrap — and again lazily on each request, which catches
   * a provider created after construction, e.g. the Extended Traces middleware's
   * asynchronous `createProvider`. The `#attached` guard makes the repeat calls
   * safe.
   */
  ensureAttached(): boolean {
    if (this.#attached) {
      return true;
    }

    if (attachToGlobalProvider(this)) {
      this.#attached = true;
    }

    return this.#attached;
  }

  /**
   * Open a step window: AI metadata from spans ending while this window is open
   * is folded into its accumulator.
   */
  openStepWindow(rootSpanId: string): void {
    this.#stepWindows.set(rootSpanId, null);
  }

  /**
   * Close a step window and drain its accumulator. Called by the engine in the
   * step's teardown, before the step's outgoing op is finalized, so the
   * returned values can ride the op as metadata. Returns `undefined` when no AI
   * metadata accumulated, so steps with no AI activity stamp nothing.
   */
  closeStepWindow(rootSpanId: string): StepWindowMetadata | undefined {
    const aiMetadata = this.#stepWindows.get(rootSpanId);
    this.#stepWindows.delete(rootSpanId);

    if (!aiMetadata) {
      return undefined;
    }

    // Map the internal camelCase shape onto the server's `inngest.ai` schema
    // (snake_case keys). We only emit the fields we extract; absent fields are
    // omitted rather than zero-valued.
    const values: Record<string, unknown> = {};
    if (aiMetadata.model !== undefined) {
      values.model = aiMetadata.model;
    }
    if (aiMetadata.inputTokens !== undefined) {
      values.input_tokens = aiMetadata.inputTokens;
    }

    if (Object.keys(values).length === 0) {
      return undefined;
    }

    this.#logger.debug(
      { rootSpanId, ...values },
      "[span-metadata] step window closed with AI metadata",
    );

    return { kind: "inngest.ai", values };
  }

  /**
   * Fold AI metadata extracted from a span that just ended into its root's step
   * window, if one is open.
   */
  #recordSpanEndInStepWindow(rootSpanId: string, span: ReadableSpan): void {
    if (!this.#stepWindows.has(rootSpanId)) {
      return;
    }

    const aiMetadata = extractAIMetadataFromAttributes(span.attributes);
    if (Object.keys(aiMetadata).length === 0) {
      return;
    }

    const acc = this.#stepWindows.get(rootSpanId);
    this.#stepWindows.set(
      rootSpanId,
      acc ? aggregate(acc, aiMetadata) : aiMetadata,
    );
  }

  protected override onSpanEnding(
    span: ReadableSpan,
    rootSpanId: string,
  ): void {
    this.#recordSpanEndInStepWindow(rootSpanId, span);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
