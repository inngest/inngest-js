import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Logger } from "../../../middleware/logger.ts";
import { InngestSpanProcessorBase } from "./baseProcessor.ts";

/**
 * A passive, read-only OTel span processor that is entirely independent of the
 * Extended Traces processor (`InngestSpanProcessor`).
 *
 * It reuses the shared run/span tracking from {@link InngestSpanProcessorBase}
 * but adds none of the export behaviour: it never mutates spans (the
 * `onSpanTracked` hook is left as the base's no-op) and never exports. Because
 * it touches no OTel global state, it cannot interfere with the host app's
 * tracing or with Extended Traces — it merely observes the same spans.
 *
 * PROTOTYPE: on each tracked span ending it logs the span and its run root span
 * ID. The full feature will accumulate per-step span data and write it back to
 * step metadata; this proves an independent processor can resolve the run root
 * for ending spans.
 */
export class InngestMetadataSpanProcessor extends InngestSpanProcessorBase {
  #logger: Logger;

  constructor(logger: Logger) {
    super();
    this.#logger = logger;
  }

  protected override onSpanEnding(
    span: ReadableSpan,
    rootSpanId: string,
  ): void {
    this.#logger.info(
      {
        spanId: span.spanContext().spanId,
        rootSpanId,
        name: span.name,
      },
      "[span-metadata] span ended",
    );
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
