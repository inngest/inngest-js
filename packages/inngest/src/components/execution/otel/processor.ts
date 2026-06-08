import type { Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  detectResources,
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  type Resource,
  serviceInstanceIdDetector,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import { deterministicSpanID } from "../../../helpers/deterministicId.ts";
import { hashSigningKey } from "../../../helpers/strings.ts";
import type { Inngest } from "../../Inngest.ts";
import { getAsyncCtx } from "../als.ts";
import { clientProcessorMap } from "./access.ts";
import { InngestSpanProcessorBase, type ParentState } from "./baseProcessor.ts";
import { Attribute, debugPrefix } from "./consts.ts";

const processorDevDebug = Debug(`${debugPrefix}:InngestSpanProcessor`);

/**
 * A set of resource attributes that are used to identify the Inngest app and
 *  the function that is being executed. This is used to store the resource
 *  attributes for the spans that are exported to the Inngest endpoint, and cache
 *  them for later use.
 */
let _resourceAttributes: Resource | undefined;

/**
 * An OTel span processor that is used to export spans to the Inngest endpoint.
 * This is used to track spans that are created within an Inngest run and export
 * them to the Inngest endpoint for tracing.
 *
 * It builds on {@link InngestSpanProcessorBase} for run/span tracking, and adds
 * the export-specific behaviour: stamping Inngest attributes onto each tracked
 * span (for indexing), the deterministic step-parent ids used in checkpointing
 * mode, and exporting ended spans via a `BatchSpanProcessor`.
 *
 * THIS IS THE INTERNAL IMPLEMENTATION OF THE SPAN PROCESSOR AND SHOULD NOT BE
 * USED BY USERS DIRECTLY. USE THE {@link PublicInngestSpanProcessor} CLASS
 * INSTEAD.
 */
export class InngestSpanProcessor extends InngestSpanProcessorBase {
  constructor(
    /**
     * The app that this span processor is associated with. This is used to
     * determine the Inngest endpoint to export spans to.
     *
     * It is optional here as this is the private constructor and only used
     * internally; we set `app` elsewhere as when we create the processor (as
     * early as possible when the process starts) we don't necessarily have the
     * app available yet.
     */
    app?: Inngest.Like,
  ) {
    super();
    if (app) {
      clientProcessorMap.set(app as Inngest.Any, this);
    }
  }

  /**
   * A `BatchSpanProcessor` that is used to export spans to the Inngest
   * endpoint. This is created lazily to avoid creating it until the Inngest App
   * has been initialized and has had a chance to receive environment variables,
   * which may be from an incoming request.
   */
  #batcher: Promise<BatchSpanProcessor> | undefined;

  /**
   * Tracks the currently-executing step for each execution, keyed by root span
   * ID. Used to compute deterministic parent span IDs for userland spans when
   * checkpointing is enabled and multiple steps run in a single invocation.
   */
  #activeStepContext = new Map<
    string,
    { hashedStepId: string; attempt: number; id: string; index: number }
  >();

  /**
   * Root span IDs that have had at least one step execution declared, meaning
   * they are checkpointing runs. Used to filter out infrastructure spans
   * (checkpoint POSTs, dev server polls) that fire between steps.
   */
  #checkpointingRoots = new Set<string>();

  /**
   * Declare that a step is currently executing. Userland spans created while
   * a step context is active are stamped with the step's identity and a
   * deterministic parent span ID matching the span the Go executor creates.
   */
  public declareStepExecution(
    rootSpanId: string,
    id: string,
    index: number,
    hashedStepId: string,
    attempt: number,
  ): void {
    processorDevDebug(
      "declareStepExecution: rootSpanId=%s hashedStepId=%s attempt=%d",
      rootSpanId,
      hashedStepId,
      attempt,
    );
    this.#checkpointingRoots.add(rootSpanId);
    this.#activeStepContext.set(rootSpanId, {
      hashedStepId,
      attempt,
      id,
      index,
    });
  }

  /**
   * Clear the active step context after a step finishes executing.
   */
  public clearStepExecution(rootSpanId: string): void {
    processorDevDebug("clearStepExecution: rootSpanId=%s", rootSpanId);
    this.#activeStepContext.delete(rootSpanId);
  }

  /**
   * A getter for retrieving resource attributes for the current process.
   */
  static get resourceAttributes(): Resource {
    if (!_resourceAttributes) {
      _resourceAttributes = detectResources({
        detectors: [
          osDetector,
          envDetector,
          hostDetector,
          processDetector,
          serviceInstanceIdDetector,
        ],
      });
    }

    return _resourceAttributes;
  }

  /**
   * Bootstrap the batcher (and its async context) as early as possible, before
   * we have a span to export, by piggybacking on the run's starting span.
   */
  public override declareStartingSpan(args: {
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void {
    // Upsert the batcher ready for later. We do this here to bootstrap it with
    // the correct async context as soon as we can, as this method is only
    // called just before execution.
    void this.ensureBatcherInitialized();

    super.declareStartingSpan(args);
  }

  /**
   * Stamp Inngest identifiers (and, for the root, resource attributes) onto each
   * tracked span so the Inngest endpoint can index and parent them.
   */
  protected override onSpanTracked(
    span: Span,
    parentState: ParentState,
    isRoot: boolean,
  ): void {
    // Set resource attributes (runtime, paths, etc.) on the root span only.
    if (isRoot) {
      span.setAttributes(InngestSpanProcessor.resourceAttributes.attributes);
    }

    const stepCtx = this.#activeStepContext.get(parentState.rootSpanId);
    if (stepCtx) {
      span.setAttribute(Attribute.InngestStepId, stepCtx.id);
      span.setAttribute(Attribute.InngestStepIndex, stepCtx.index);
      span.setAttribute(Attribute.InngestStepHash, stepCtx.hashedStepId);
      span.setAttribute(Attribute.InngestStepAttempt, stepCtx.attempt);
    }

    // For direct children of the root span during step execution, set the
    // deterministic step span ID. The Go executor creates executor.step spans
    // with the same deterministic ID (from the same seed), so ingestion can
    // parent userland spans under the correct step.
    if (!isRoot) {
      const spanParentId =
        (span as unknown as ReadableSpan).parentSpanContext?.spanId ??
        (span as unknown as { parentSpanId?: string }).parentSpanId;

      if (spanParentId === parentState.rootSpanId && stepCtx) {
        const seed = stepCtx.hashedStepId + ":" + String(stepCtx.attempt);
        const newSpanId = deterministicSpanID(seed);
        processorDevDebug(
          "setting inngest.step.parentSpanId=%s (seed=%s) on span %s",
          newSpanId,
          seed,
          span.spanContext().spanId,
        );
        span.setAttribute(Attribute.InngestStepParentSpanId, newSpanId);
      }
    }

    span.setAttribute(Attribute.InngestTraceparent, parentState.traceparent);
    span.setAttribute(Attribute.InngestRunId, parentState.runId);

    if (parentState.appId) {
      span.setAttribute(Attribute.InngestAppId1, parentState.appId);
      span.setAttribute(Attribute.InngestAppId2, parentState.appId);
    }

    if (parentState.functionId) {
      span.setAttribute(Attribute.InngestFunctionId, parentState.functionId);
    }

    if (parentState.traceRef) {
      span.setAttribute(Attribute.InngestTraceRef, parentState.traceRef);
    }
  }

  /**
   * In checkpointing mode, only track spans during active step execution. This
   * filters out infrastructure spans (checkpoint POSTs, dev server polls) that
   * fire between steps and would otherwise pollute the tree.
   */
  protected override shouldTrackChild(parentState: ParentState): boolean {
    if (
      this.#checkpointingRoots.has(parentState.rootSpanId) &&
      !this.#activeStepContext.has(parentState.rootSpanId)
    ) {
      processorDevDebug("skipping span - checkpointing between steps");
      return false;
    }

    return true;
  }

  /**
   * Export the ending span via the batcher.
   */
  protected override onSpanEnding(
    span: ReadableSpan,
    _rootSpanId: string,
  ): void {
    if (!this.#batcher) {
      return void processorDevDebug(
        "batcher not initialized, so failed exporting span",
        span.spanContext().spanId,
      );
    }

    processorDevDebug("exporting span", span.spanContext().spanId);
    void this.#batcher.then((batcher) => batcher.onEnd(span));
  }

  /**
   * The batcher is a singleton used to export spans to the OTel endpoint. It is
   * created lazily to avoid creating it until the Inngest App has been
   * initialized and has had a chance to receive environment variables, which may
   * be from an incoming request.
   */
  private ensureBatcherInitialized(): Promise<BatchSpanProcessor> {
    if (!this.#batcher) {
      this.#batcher = new Promise(async (resolve, reject) => {
        try {
          // We retrieve the app from the async context, so we must make sure
          // that this function is called from the correct chain.
          const store = await getAsyncCtx();
          if (!store) {
            throw new Error(
              "No async context found; cannot create batcher to export traces",
            );
          }

          const app = store.app as Inngest.Any;

          const path = "/v1/traces/userland";
          const url = new URL(path, app.apiBaseUrl);

          processorDevDebug(
            "batcher lazily accessed; creating new batcher with URL",
            url,
          );

          const exporter = new OTLPTraceExporter({
            url: url.href,
            headers: {
              ...app.headers,
              Authorization: `Bearer ${hashSigningKey(app.signingKey)}`,
            },
          });

          resolve(new BatchSpanProcessor(exporter));
        } catch (err) {
          reject(err);
        }
      });
    }

    return this.#batcher;
  }

  /**
   * Force the batcher to flush any spans that are currently buffered. Called in
   * the `wrapRequest` middleware hook so spans for a run are exported before the
   * serverless process is killed.
   */
  async forceFlush(): Promise<void> {
    const flushDebug = processorDevDebug.extend("forceFlush");
    flushDebug("force flushing batcher");

    return this.#batcher
      ?.then((batcher) => batcher.forceFlush())
      .catch((err) => {
        flushDebug("error flushing batcher", err, "ignoring");
      });
  }

  async shutdown(): Promise<void> {
    processorDevDebug.extend("shutdown")("shutting down batcher");

    return this.#batcher?.then((batcher) => batcher.shutdown());
  }
}

/**
 * An OTel span processor that is used to export spans to the Inngest endpoint.
 * This is used to track spans that are created within an Inngest run and export
 * them to the Inngest endpoint for tracing.
 *
 * It's careful to only pick relevant spans to export and will not send any
 * irrelevant spans to the Inngest endpoint.
 */
export class PublicInngestSpanProcessor extends InngestSpanProcessor {
  constructor(
    /**
     * The app that this span processor is associated with. This is used to
     * determine the Inngest endpoint to export spans to.
     */
    app: Inngest.Like,
  ) {
    super(app);
  }
}
