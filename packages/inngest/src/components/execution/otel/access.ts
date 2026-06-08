/**
 * A file used to access client processors safely without also importing any
 * otel-specific libraries. Useful for ensuring that the otel libraries can be
 * tree-shaken if they're not used directly by the user.
 */

import type { Span } from "@opentelemetry/api";
import type { Inngest } from "../../Inngest.ts";

export interface InngestTraceLifecycleProcessor {
  declareStartingSpan(args: {
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void;

  declareStepExecution(
    rootSpanId: string,
    id: string,
    index: number,
    hashedStepId: string,
    attempt: number,
  ): void;

  clearStepExecution(rootSpanId: string): void;
}

/**
 * A map of Inngest clients to their OTel span processors. This is used to
 * ensure that we only create one span processor per client, and that we can
 * access the span processor from the client without exposing the OTel
 * libraries to the user.
 */
export const clientProcessorMap = new WeakMap<
  Inngest.Any,
  InngestTraceLifecycleProcessor[]
>();

export const registerClientProcessor = (
  client: Inngest.Any,
  processor: InngestTraceLifecycleProcessor,
): void => {
  let processors = clientProcessorMap.get(client);
  if (!processors) {
    processors = [];
    clientProcessorMap.set(client, processors);
  }

  if (!processors.includes(processor)) {
    processors.push(processor);
  }
};
