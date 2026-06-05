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

class ClientProcessorRegistry implements InngestTraceLifecycleProcessor {
  #processors = new Set<InngestTraceLifecycleProcessor>();

  add(processor: InngestTraceLifecycleProcessor): void {
    this.#processors.add(processor);
  }

  declareStartingSpan(
    args: Parameters<InngestTraceLifecycleProcessor["declareStartingSpan"]>[0],
  ): void {
    for (const processor of this.#processors) {
      processor.declareStartingSpan(args);
    }
  }

  declareStepExecution(
    ...args: Parameters<InngestTraceLifecycleProcessor["declareStepExecution"]>
  ): void {
    for (const processor of this.#processors) {
      processor.declareStepExecution(...args);
    }
  }

  clearStepExecution(
    ...args: Parameters<InngestTraceLifecycleProcessor["clearStepExecution"]>
  ): void {
    for (const processor of this.#processors) {
      processor.clearStepExecution(...args);
    }
  }
}

/**
 * A map of Inngest clients to their OTel span processors. This is used to
 * ensure that we only create one span processor per client, and that we can
 * access the span processor from the client without exposing the OTel
 * libraries to the user.
 */
export const clientProcessorMap = new WeakMap<
  Inngest.Any,
  InngestTraceLifecycleProcessor
>();

export const registerClientProcessor = (
  client: Inngest.Any,
  processor: InngestTraceLifecycleProcessor,
): void => {
  const existing = clientProcessorMap.get(client);

  if (existing instanceof ClientProcessorRegistry) {
    existing.add(processor);
    return;
  }

  const registry = new ClientProcessorRegistry();
  if (existing) {
    registry.add(existing);
  }
  registry.add(processor);

  clientProcessorMap.set(client, registry);
};
