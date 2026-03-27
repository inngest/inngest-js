import { getAsyncCtx, getAsyncCtxSync } from "./execution/als.ts";
import {
  buildSseCommitEvent,
  buildSseFailedEvent,
  buildSseRedirectEvent,
  buildSseRollbackEvent,
  buildSseStreamEvent,
  buildSseSucceededEvent,
} from "./execution/streaming.ts";

/**
 * Accepted source types for `stream.pipe()`.
 *
 * - `ReadableStream` — piped directly
 * - `AsyncIterable<string>` — iterated; each yielded value becomes a chunk
 * - `() => AsyncIterable<string>` — factory invoked lazily, then iterated
 */
export type PipeSource =
  | ReadableStream
  | AsyncIterable<string>
  | (() => AsyncIterable<string>);

/**
 * The public interface for stream tools available to user code.
 */
export interface StreamTools {
  /**
   * Push data to the client as an SSE stream event. Fire-and-forget from the
   * caller's perspective.
   *
   * Outside of an Inngest execution context this is a silent no-op (graceful
   * degradation).
   */
  push(data: unknown): void;

  /**
   * Pipe a source to the client, writing each chunk as an SSE stream event.
   * Resolves with the concatenated content of all chunks when the source is
   * fully consumed.
   *
   * Accepts a `ReadableStream`, an `AsyncIterable<string>`, or a factory
   * function that returns an `AsyncIterable<string>` (e.g. an async
   * generator function).
   *
   * Outside of an Inngest execution context this resolves with an empty string.
   */
  pipe(source: PipeSource): Promise<string>;
}

/**
 * Wraps a `TransformStream<Uint8Array>` to provide push/pipe SSE streaming
 * capabilities within an Inngest execution.
 */
export class InngestStream {
  private transform: TransformStream<Uint8Array, Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private _activated = false;
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * Optional callback invoked the first time `push` or `pipe` is called.
   * Used by the execution engine to fire a checkpoint that returns the SSE
   * Response to the client immediately.
   */
  private onActivated?: () => void;

  /**
   * Optional callback invoked when a write to the underlying stream fails
   * (e.g. the client disconnected or the transform stream errored). Used by
   * the execution engine to emit diagnostic logs.
   */
  private onWriteError?: (err: unknown) => void;

  constructor(opts?: {
    onActivated?: () => void;
    onWriteError?: (err: unknown) => void;
  }) {
    this.onActivated = opts?.onActivated;
    this.onWriteError = opts?.onWriteError;
    this.transform = new TransformStream<Uint8Array, Uint8Array>(
      undefined,
      undefined,
      // Use a generous high water mark on the readable side so that writes
      // don't block due to backpressure before the consumer reads.
      new CountQueuingStrategy({ highWaterMark: 1024 }),
    );
    this.writer = this.transform.writable.getWriter();
  }

  /**
   * Whether `push` or `pipe` has been called at least once.
   */
  get activated(): boolean {
    return this._activated;
  }

  /**
   * The readable side of the underlying transform stream. Consumers (i.e. the
   * HTTP response) read SSE events from here.
   */
  get readable(): ReadableStream<Uint8Array> {
    return this.transform.readable;
  }

  /**
   * Resolve the current step ID for stream events. Returns the executing
   * step's hashed ID (read from ALS), or undefined if outside a step.
   */
  private currentStepId(): string | undefined {
    return getAsyncCtxSync()?.execution?.executingStep?.hashedId;
  }

  private activate(): void {
    if (!this._activated) {
      this._activated = true;
      this.onActivated?.();
    }
  }

  /**
   * Enqueue a pre-built SSE event string onto the write chain.
   */
  private enqueue(sseEvent: string): void {
    this.writeChain = this.writeChain
      .then(() => this.writer.write(this.encoder.encode(sseEvent)))
      .catch((err) => {
        // Writer errored (e.g. stream closed) — swallow so the chain
        // doesn't break and subsequent writes fail gracefully.
        this.onWriteError?.(err);
      });
  }

  /**
   * Emit an `inngest.commit` SSE event indicating that uncommitted streamed data
   * should be committed (i.e. will not be rolled back). Internal use only.
   */
  commit(hashedStepId: string | null): void {
    this.enqueue(buildSseCommitEvent(hashedStepId));
  }

  /**
   * Emit an `inngest.rollback` SSE event indicating the uncommitted streamed
   * data should be discarded (e.g. step errored). Internal use only.
   */
  rollback(hashedStepId: string | null): void {
    this.enqueue(buildSseRollbackEvent(hashedStepId));
  }

  /**
   * Write a single SSE stream event containing `data`. The current step's
   * hashed ID is automatically included as stepId for rollback tracking.
   */
  push(data: unknown): void {
    this.activate();

    const stepId = this.currentStepId();

    let sseEvent: string;
    try {
      sseEvent = buildSseStreamEvent(data, stepId);
    } catch {
      // data is not JSON-serializable (e.g. circular reference) — skip
      return;
    }

    this.enqueue(sseEvent);
  }

  /**
   * Pipe a source to the client, writing each chunk as an SSE stream event.
   * Returns the concatenated content of all chunks.
   */
  async pipe(source: PipeSource): Promise<string> {
    this.activate();

    // Resolve the source into an AsyncIterable<string>.
    // Check ReadableStream first — on Node 18+ ReadableStream implements
    // Symbol.asyncIterator, so the instanceof check must come before
    // the async-iterable duck-type test.
    let iterable: AsyncIterable<string>;
    if (source instanceof ReadableStream) {
      iterable = this.readableToAsyncIterable(source);
    } else if (typeof source === "function") {
      iterable = source();
    } else {
      iterable = source;
    }

    return this.pipeIterable(iterable);
  }

  /**
   * Adapt a ReadableStream into an AsyncIterable<string>.
   */
  private async *readableToAsyncIterable(
    readable: ReadableStream,
  ): AsyncIterable<string> {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield typeof value === "string" ? value : decoder.decode(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Core pipe loop: iterate an async iterable, writing each chunk as an SSE
   * stream event and collecting the concatenated result.
   */
  private async pipeIterable(source: AsyncIterable<string>): Promise<string> {
    const stepId = this.currentStepId();
    const chunks: string[] = [];

    for await (const chunk of source) {
      chunks.push(chunk);

      let sseEvent: string;
      try {
        sseEvent = buildSseStreamEvent(chunk, stepId);
      } catch {
        continue;
      }

      this.enqueue(sseEvent);
      await this.writeChain;
    }

    return chunks.join("");
  }

  /**
   * Write a redirect info event. Tells the client where to reconnect if the
   * durable endpoint goes async. Does NOT close the writer — more stream
   * events may follow before the durable endpoint actually switches to async
   * mode. Internal use only.
   */
  sendRedirectInfo(data: { runId: string; url: string }): void {
    this.enqueue(buildSseRedirectEvent(data));
  }

  /**
   * Write a succeeded result event and close the writer. Internal use only.
   */
  closeSucceeded(
    data?: unknown,
    responseInfo?: { statusCode?: number; headers?: Record<string, string> },
  ): void {
    let sseEvent: string;
    try {
      sseEvent = buildSseSucceededEvent(data, responseInfo);
    } catch {
      sseEvent = buildSseFailedEvent("Failed to serialize result");
    }
    this.closeWithEvent(sseEvent);
  }

  /**
   * Write a failed result event and close the writer. Internal use only.
   */
  closeFailed(error: string): void {
    this.closeWithEvent(buildSseFailedEvent(error));
  }

  private closeWithEvent(sseEvent: string): void {
    this.writeChain = this.writeChain
      .then(() => this.writer.write(this.encoder.encode(sseEvent)))
      .then(() => this.writer.close())
      .catch((err) => {
        // Writer already errored/closed — nothing to do.
        this.onWriteError?.(err);
      });
  }

  /**
   * Close the writer without writing a result event. Used when the durable endpoint goes
   * async and the real result will arrive on the redirected stream.
   */
  end(): void {
    this.writeChain = this.writeChain
      .then(() => this.writer.close())
      .catch((err) => {
        // Writer already errored/closed — nothing to do.
        this.onWriteError?.(err);
      });
  }
}

/** Synchronous ALS lookup for the stream tools (fast path). */
const getStreamToolsSync = (): InngestStream | undefined => {
  const ctx = getAsyncCtxSync();
  return ctx?.execution?.stream;
};

const getDeferredStreamTooling = async (): Promise<
  InngestStream | undefined
> => {
  const ctx = await getAsyncCtx();
  return ctx?.execution?.stream;
};

/**
 * Stream tools that use ALS to resolve the current execution context.
 * Outside an Inngest execution, `push()` is a no-op and `pipe()` resolves immediately.
 */
export const stream: StreamTools = {
  push: (data) => {
    // Sync fast path: activate the stream before the next microtask tick.
    const syncStream = getStreamToolsSync();
    if (syncStream) {
      syncStream.push(data);
      return;
    }

    // Fallback: ALS not yet initialized (first import still resolving).
    void getDeferredStreamTooling()
      .then((s) => {
        s?.push(data);
      })
      .catch(() => {});
  },
  pipe: async (source) => {
    const syncStream = getStreamToolsSync();
    if (syncStream) {
      return syncStream.pipe(source);
    }

    const s = await getDeferredStreamTooling();
    if (s) {
      return s.pipe(source);
    }
    return "";
  },
};
