import type { Span } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import type { MetadataTarget } from "../../../../types.ts";
import type { Inngest } from "../../../Inngest.ts";
import { getAsyncCtxSync } from "../../als.ts";
import { registerClientProcessor } from "../access.ts";
import { debugPrefix } from "../consts.ts";
import {
  createProviderWithProcessor,
  extendProviderWithProcessor,
} from "../util.ts";
import { registerAIMetadataInstrumentations } from "./instrumentations.ts";
import { extractAIMetadata } from "./libStrategies/index.ts";
import { aiMetadataKind } from "./metadata.ts";

const aiMetadataDebug = Debug(`${debugPrefix}:AIMetadataSpanProcessor`);

type StepContext = {
  id: string;
  index?: number;
  attempt?: number;
};

type SpanState = {
  runId: string;
  rootSpanId: string;
  step?: StepContext;
  headers?: Record<string, string>;
};

type SpanIdProvider = {
  spanContext(): { spanId: string };
};

const processors = new WeakMap<Inngest.Any, InngestAIMetadataSpanProcessor>();

export const registerAIMetadataSpanProcessor = (client: Inngest.Any): void => {
  if (processors.has(client)) {
    return;
  }

  const processor = new InngestAIMetadataSpanProcessor(client);
  processors.set(client, processor);
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
  constructor(private client: Inngest.Any) {}

  #spansToProcess = new Set<string>();
  #spanStates = new Map<string, SpanState>();
  #spanCleanup = new FinalizationRegistry<string>((spanId) => {
    if (spanId) {
      this.#spanStates.delete(spanId);
    }
  });
  #activeStepContext = new Map<string, StepContext>();
  #checkpointingRoots = new Set<string>();

  declareStartingSpan({
    span,
    runId,
  }: {
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void {
    this.trackSpan(
      {
        runId,
        rootSpanId: span.spanContext().spanId,
        headers: this.getCurrentHeaders(),
      },
      span,
    );
  }

  declareStepExecution(
    rootSpanId: string,
    id: string,
    index: number,
    _hashedStepId: string,
    attempt: number,
  ): void {
    this.#checkpointingRoots.add(rootSpanId);
    this.#activeStepContext.set(rootSpanId, { id, index, attempt });
  }

  clearStepExecution(rootSpanId: string): void {
    this.#activeStepContext.delete(rootSpanId);
  }

  onStart(span: Span): void {
    const spanId = span.spanContext().spanId;
    const parentSpanId = getParentSpanId(span);

    if (!parentSpanId) {
      return;
    }

    const parentState = this.#spanStates.get(parentSpanId);
    if (!parentState) {
      return;
    }

    if (
      this.#checkpointingRoots.has(parentState.rootSpanId) &&
      !this.#activeStepContext.has(parentState.rootSpanId)
    ) {
      aiMetadataDebug("skipping span between checkpointing steps", spanId);
      return;
    }

    this.trackSpan(parentState, span);
  }

  onEnd(span: ReadableSpan): void {
    const spanId = span.spanContext().spanId;

    try {
      if (!this.#spansToProcess.has(spanId)) {
        return;
      }

      const state = this.#spanStates.get(spanId);
      const step = state?.step;
      if (!state || !step) {
        return;
      }

      const values = extractAIMetadata(span);
      if (Object.keys(values).length === 0) {
        return;
      }

      this.updateStepMetadata({ ...state, step }, values);
    } finally {
      this.cleanupSpan(span);
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}

  private trackSpan(parentState: SpanState, span: Span): void {
    const spanId = span.spanContext().spanId;
    const step = this.getCurrentStep(parentState.rootSpanId);
    const state: SpanState = {
      ...parentState,
      headers: parentState.headers ?? this.getCurrentHeaders(),
    };

    if (step) {
      state.step = step;
    }

    this.#spanCleanup.register(span, spanId, span);
    this.#spansToProcess.add(spanId);
    this.#spanStates.set(spanId, state);
  }

  private cleanupSpan(span: SpanIdProvider): void {
    const spanId = span.spanContext().spanId;

    this.#spanCleanup.unregister(span);
    this.#spansToProcess.delete(spanId);
    this.#spanStates.delete(spanId);
  }

  private getCurrentStep(rootSpanId: string): StepContext | undefined {
    const activeStep = this.#activeStepContext.get(rootSpanId);
    if (activeStep) {
      return activeStep;
    }

    const execution = getAsyncCtxSync()?.execution;
    const executingStep = execution?.executingStep;
    if (!executingStep?.id) {
      return undefined;
    }

    return {
      id: executingStep.id,
      attempt: execution?.ctx.attempt,
    };
  }

  private getCurrentHeaders(): Record<string, string> | undefined {
    return getAsyncCtxSync()?.execution?.instance.headers;
  }

  private updateStepMetadata(
    state: SpanState & { step: StepContext },
    values: Record<string, unknown>,
  ): void {
    const execution = getAsyncCtxSync()?.execution;
    const canBatch =
      execution?.ctx.runId === state.runId &&
      execution.executingStep?.id === state.step.id &&
      execution.ctx.attempt === state.step.attempt;

    if (
      canBatch &&
      execution?.instance.addMetadata(
        state.step.id,
        aiMetadataKind,
        "step",
        "merge",
        values,
      )
    ) {
      return;
    }

    const target: MetadataTarget = {
      run_id: state.runId,
      step_id: state.step.id,
      step_index: state.step.index,
      step_attempt: state.step.attempt,
    };

    void import("../../../InngestMetadata.ts")
      .then(({ sendMetadataViaAPI }) =>
        sendMetadataViaAPI(
          this.client,
          target,
          aiMetadataKind,
          "merge",
          values,
          state.headers,
        ),
      )
      .catch((err) => {
        aiMetadataDebug("failed to update AI metadata", err);
      });
  }
}

const getParentSpanId = (span: Span): string | undefined => {
  if ("parentSpanContext" in span) {
    const spanId = getSpanIdFromContext(span.parentSpanContext);
    if (spanId) {
      return spanId;
    }
  }

  if ("parentSpanId" in span && typeof span.parentSpanId === "string") {
    return span.parentSpanId;
  }

  return undefined;
};

const getSpanIdFromContext = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("spanId" in value)) {
    return undefined;
  }

  if (typeof value.spanId !== "string") {
    return undefined;
  }

  return value.spanId;
};
