/**
 * A file used to access client processors safely without also importing any
 * otel-specific libraries. Useful for ensuring that the otel libraries can be
 * tree-shaken if they're not used directly by the user.
 */

import type { Span } from "@opentelemetry/api";
import type { Inngest } from "../../Inngest.ts";
import type { MetadataKind, MetadataValues } from "../../InngestMetadata.ts";

/**
 * What a processor contributes to a step's metadata when its step window
 * closes: a single metadata `kind` and the `values` to merge under it. The
 * processor owns the kind so the engine doesn't hardcode it.
 */
export interface StepWindowMetadata {
  kind: MetadataKind;
  values: MetadataValues;
}

/**
 * The engine→processor channel. Any Inngest-aware span processor implements the
 * lifecycle hooks it cares about; the engine fans out to every processor
 * registered for a client. `declareStartingSpan` is required (every processor
 * needs the run root); the step-lifecycle hooks are optional, so each processor
 * implements only what it needs (extended traces: export + checkpointing; the
 * metadata processor: per-step accumulation).
 */
export interface InngestRunSpanProcessor {
  declareStartingSpan(args: {
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void;
  declareStepExecution?(
    rootSpanId: string,
    id: string,
    index: number,
    hashedStepId: string,
    attempt: number,
  ): void;
  clearStepExecution?(rootSpanId: string): void;
  openStepWindow?(rootSpanId: string): void;
  closeStepWindow?(rootSpanId: string): StepWindowMetadata | undefined;
}

/**
 * A map of Inngest clients to their OTel span processors. A client may have
 * more than one processor (e.g. extended traces and the built-in metadata
 * processor), so the value is a set; the engine fans out lifecycle calls to all
 * of them. This lets us access processors from the client without exposing the
 * OTel libraries to the user.
 */
export const clientProcessorMap = new WeakMap<
  Inngest.Any,
  Set<InngestRunSpanProcessor>
>();

/**
 * Register a processor for a client, creating the backing set on first use.
 * Idempotent by object identity (the set dedupes), so a processor registered
 * by both its constructor and a middleware `onRegister` is added only once.
 */
export function registerClientProcessor(
  client: Inngest.Any,
  processor: InngestRunSpanProcessor,
): void {
  let set = clientProcessorMap.get(client);
  if (!set) {
    set = new Set();
    clientProcessorMap.set(client, set);
  }
  set.add(processor);
}
