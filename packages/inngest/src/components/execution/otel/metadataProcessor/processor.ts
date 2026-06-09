import { type Context, type Span, trace } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import type { Inngest } from "../../../Inngest.ts";
import { getAsyncCtxSync } from "../../als.ts";
import { registerClientProcessor } from "../access.ts";
import { debugPrefix } from "../consts.ts";
import {
  createProviderWithProcessor,
  extendProviderWithProcessor,
} from "../util.ts";
import { registerAIMetadataInstrumentations } from "./instrumentations.ts";
import { extractAIMetadata } from "./libExtractors/index.ts";
import { aiMetadataKind } from "./metadata.ts";

const aiMetadataDebug = Debug(`${debugPrefix}:AIMetadataSpanProcessor`);

type StepContext = {
  id: string;
};

type SpanState = {
  rootSpanId: string;
  step?: StepContext;
};

/**
 * Register one metadata processor for this client. OTel span processors are
 * global, so each processor must later ignore spans that do not belong to its
 * own client's declared execution root.
 */
export const registerAIMetadataSpanProcessor = (client: Inngest.Any): void => {
  const processor = new InngestAIMetadataSpanProcessor();
  registerClientProcessor(client, processor);

  void registerAIMetadataInstrumentations().catch((err) => {
    aiMetadataDebug("unable to register AI metadata instrumentations", err);
  });

  const extended = extendProviderWithProcessor(processor, "auto");
  if (extended.success) {
    return;
  }

  void createProviderWithProcessor(processor).then((created) => {
    if (!created.success) {
      aiMetadataDebug("unable to create provider", created.error);
    }
  });
};

export class InngestAIMetadataSpanProcessor implements SpanProcessor {
  /**
   * Populated only for checkpointing executions today. Multiple steps can run
   * under the same root span, so the engine tells us which step is active.
   */
  #activeStepContext = new Map<string, StepContext>();

  /**
   * Tracks only spans under an Inngest root declared to this processor. This
   * prevents multiple Inngest clients in one process from all writing metadata
   * for the same AI span.
   */
  #spanStates = new Map<string, SpanState>();

  /**
   * Normal span end calls cleanupSpan(). Use FinalizationRegistry to
   * automatically remove state if a tracked span is garbage-collected without
   * ending.
   */
  #spanCleanup = new FinalizationRegistry<string>((spanId) => {
    this.#spanStates.delete(spanId);
  });

  /**
   * Called when the engine starts the `inngest.execution` root span, before
   * user steps run. This root span is the ownership boundary for this
   * processor.
   */
  declareStartingSpan(args: {
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void {
    this.trackSpan(args.span, {
      rootSpanId: args.span.spanContext().spanId,
    });
  }

  /**
   * Called before a checkpointing step handler runs. Non-checkpointing steps do
   * not call this today, so they use the active execution context instead.
   */
  declareStepExecution(
    rootSpanId: string,
    id: string,
    _index: number,
    _hashedStepId: string,
    _attempt: number,
  ): void {
    this.#activeStepContext.set(rootSpanId, { id });
  }

  /**
   * Called after a checkpointing step handler finishes, paired with
   * declareStepExecution().
   */
  clearStepExecution(rootSpanId: string): void {
    this.#activeStepContext.delete(rootSpanId);
  }

  /**
   * OTel hook called when any span starts. Track spans whose parent is already
   * owned by this processor.
   */
  onStart(span: Span, parentContext: Context): void {
    // Follow only spans whose parent is already tracked. This mirrors Extended
    // Traces and keeps unrelated process-level OTel spans out of metadata.
    const parentSpanId = trace.getSpanContext(parentContext)?.spanId;
    if (!parentSpanId) {
      return;
    }

    const parentState = this.#spanStates.get(parentSpanId);
    if (!parentState) {
      return;
    }

    const step =
      parentState.step ?? this.getCurrentStep(parentState.rootSpanId);
    if (!step) {
      return;
    }

    this.trackSpan(span, {
      rootSpanId: parentState.rootSpanId,
      step,
    });
  }

  /**
   * OTel hook called when any span ends. Extract AI metadata from tracked spans
   * and attach it to the step captured at span start.
   */
  onEnd(span: ReadableSpan): void {
    const spanState = this.#spanStates.get(span.spanContext().spanId);

    try {
      const step = spanState?.step;
      if (!step) {
        return;
      }

      const execution = getAsyncCtxSync()?.execution;
      // If the span ends after the step changed or outside execution context,
      // do not attach metadata to a stale or unrelated step.
      if (!execution || execution.executingStep?.id !== step.id) {
        return;
      }

      const values = extractAIMetadata(span);
      if (Object.keys(values).length === 0) {
        return;
      }

      if (
        !execution.instance.addMetadata(
          step.id,
          aiMetadataKind,
          "step",
          "merge",
          values,
        )
      ) {
        aiMetadataDebug("failed to add AI metadata to checkpoint payload");
      }
    } finally {
      this.cleanupSpan(span);
    }
  }

  /**
   * Required OTel SpanProcessor method. No-op because metadata extraction does
   * not buffer or export spans.
   */
  async forceFlush(): Promise<void> {}

  /**
   * Required OTel SpanProcessor method. No-op because metadata extraction does
   * not own any exporter resources.
   */
  async shutdown(): Promise<void> {}

  /**
   * Finds the Inngest step a newly-started child span should attach to.
   * Checkpointing steps are declared by the engine; non-checkpointing steps
   * fall back to the active execution context.
   */
  private getCurrentStep(rootSpanId: string): StepContext | undefined {
    const activeStep = this.#activeStepContext.get(rootSpanId);
    if (activeStep) {
      return activeStep;
    }

    // Non-checkpointing executions do not declare step lifecycle to processors,
    // but onStart() still runs inside the step's ALS context.
    const stepId = getAsyncCtxSync()?.execution?.executingStep?.id;
    if (!stepId) {
      return;
    }

    return { id: stepId };
  }

  /**
   * Marks a span as owned by this processor so child spans can be followed and
   * ended spans can be matched back to their step.
   */
  private trackSpan(span: Span, state: SpanState): void {
    const spanId = span.spanContext().spanId;
    this.#spanCleanup.register(span, spanId, span);
    this.#spanStates.set(spanId, state);
  }

  /**
   * Removes tracking state after a span ends and unregisters the GC fallback.
   */
  private cleanupSpan(span: ReadableSpan): void {
    const spanId = span.spanContext().spanId;
    this.#spanCleanup.unregister(span);
    this.#spanStates.delete(spanId);
  }
}
