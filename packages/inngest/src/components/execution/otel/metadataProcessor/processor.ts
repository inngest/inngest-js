import type { Span } from "@opentelemetry/api";
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
  #activeStepContext = new Map<string, StepContext>();
  #spanStates = new Map<string, SpanState>();
  #spanCleanup = new FinalizationRegistry<string>((spanId) => {
    this.#spanStates.delete(spanId);
  });

  declareStartingSpan(args: {
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void {
    this.trackSpan(args.span, {
      rootSpanId: getSpanId(args.span),
    });
  }

  declareStepExecution(
    rootSpanId: string,
    id: string,
    _index: number,
    _hashedStepId: string,
    _attempt: number,
  ): void {
    this.#activeStepContext.set(rootSpanId, { id });
  }

  clearStepExecution(rootSpanId: string): void {
    this.#activeStepContext.delete(rootSpanId);
  }

  onStart(span: Span): void {
    const parentSpanId = getParentSpanId(span);
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

  onEnd(span: ReadableSpan): void {
    const spanState = this.#spanStates.get(getSpanId(span));

    try {
      const step = spanState?.step;
      if (!step) {
        return;
      }

      const execution = getAsyncCtxSync()?.execution;
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

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}

  private getCurrentStep(rootSpanId: string): StepContext | undefined {
    const activeStep = this.#activeStepContext.get(rootSpanId);
    if (activeStep) {
      return activeStep;
    }

    const stepId = getAsyncCtxSync()?.execution?.executingStep?.id;
    if (!stepId) {
      return;
    }

    return { id: stepId };
  }

  private trackSpan(span: Span, state: SpanState): void {
    const spanId = getSpanId(span);
    this.#spanCleanup.register(span, spanId, span);
    this.#spanStates.set(spanId, state);
  }

  private cleanupSpan(span: ReadableSpan): void {
    const spanId = getSpanId(span);
    this.#spanCleanup.unregister(span);
    this.#spanStates.delete(spanId);
  }
}

const getSpanId = (span: Span | ReadableSpan): string => {
  return span.spanContext().spanId;
};

const getParentSpanId = (span: Span): string | undefined => {
  if ("parentSpanContext" in span) {
    const parentSpanContext = span.parentSpanContext;
    if (
      parentSpanContext &&
      typeof parentSpanContext === "object" &&
      "spanId" in parentSpanContext &&
      typeof parentSpanContext.spanId === "string"
    ) {
      return parentSpanContext.spanId;
    }
  }

  if ("parentSpanId" in span && typeof span.parentSpanId === "string") {
    return span.parentSpanId;
  }

  return;
};
