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
  declareStartingSpan(_args: {
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void {}

  declareStepExecution(
    _rootSpanId: string,
    _id: string,
    _index: number,
    _hashedStepId: string,
    _attempt: number,
  ): void {}

  clearStepExecution(_rootSpanId: string): void {}

  onStart(_span: Span): void {}

  onEnd(span: ReadableSpan): void {
    const execution = getAsyncCtxSync()?.execution;
    const stepId = execution?.executingStep?.id;
    if (!execution || !stepId) {
      return;
    }

    const values = extractAIMetadata(span);
    if (Object.keys(values).length === 0) {
      return;
    }

    if (
      !execution.instance.addMetadata(
        stepId,
        aiMetadataKind,
        "step",
        "merge",
        values,
      )
    ) {
      aiMetadataDebug("failed to add AI metadata to checkpoint payload");
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
