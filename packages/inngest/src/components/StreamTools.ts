import { getAsyncCtx, getAsyncCtxSync } from "./execution/als.ts";
import {
  buildSseCommitEvent,
  buildSseFailedEvent,
  buildSseRedirectEvent,
  buildSseRollbackEvent,
  buildSseStreamEvent,
  buildSseSucceededEvent,
  type SseResponse,
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
export class Stream {
  private transform: TransformStream<Uint8Array, Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private _activated = false;
  private _errored = false;
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
   * Resolve the current hashed step ID for stream events. Returns the
   * executing step's hashed ID (read from ALS), or undefined if outside a step.
   */
  private currentHashedStepId(): string | undefined {
    return getAsyncCtxSync()?.execution?.executingStep?.hashedId;
  }

  private activate(): void {
    if (!this._activated) {
      this._activated = true;
      this.onActivated?.();
    }
  }

  /**
   * Encode and write an SSE event string to the underlying writer.
   */
  private writeEncoded(sseEvent: string): Promise<void> {
    return this.writer.write(this.encoder.encode(sseEvent));
  }

  /**
   * Enqueue a pre-built SSE event string onto the write chain.
   */
  private enqueue(sseEvent: string): void {
    if (this._errored) return;

    this.writeChain = this.writeChain
      .then(() => this.writeEncoded(sseEvent))
      .catch((err) => {
        // Writer errored (e.g. stream closed) — swallow so the chain
        // doesn't break and subsequent writes fail gracefully.
        this._errored = true;
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
   * Serialize `data` into an SSE stream event and enqueue it. Returns `false`
   * if serialization fails (e.g. circular reference) so callers can skip.
   */
  private enqueueStreamEvent(data: unknown, hashedStepId?: string): boolean {
    let sseEvent: string;
    try {
      sseEvent = buildSseStreamEvent(data, hashedStepId);
    } catch {
      return false;
    }

    this.enqueue(sseEvent);
    return true;
  }

  /**
   * Write a single SSE stream event containing `data`. The current step's
   * hashed ID is automatically included as stepId for rollback tracking.
   */
  push(data: unknown): void {
    this.activate();
    this.enqueueStreamEvent(data, this.currentHashedStepId());
  }

  /**
   * Pipe a source to the client, writing each chunk as an SSE stream event.
   * Returns the concatenated content of all chunks.
   */
  async pipe(source: PipeSource): Promise<string> {
    this.activate();

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
   * Adapt a ReadableStream into an AsyncIterable<string>. TypeScript's
   * ReadableStream type doesn't declare Symbol.asyncIterator, so we use the
   * reader API for type safety.
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
        yield typeof value === "string"
          ? value
          : decoder.decode(value, { stream: true });
      }
      // flush any partially buffered multibyte characters from the decoder
      const final = decoder.decode();
      if (final) yield final;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Core pipe loop: iterate an async iterable, writing each chunk as an SSE
   * stream event and collecting the concatenated result.
   */
  private async pipeIterable(source: AsyncIterable<string>): Promise<string> {
    const hashedStepId = this.currentHashedStepId();
    const chunks: string[] = [];

    for await (const chunk of source) {
      if (this._errored) break;

      chunks.push(chunk);

      if (!this.enqueueStreamEvent(chunk, hashedStepId)) {
        continue;
      }

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
  closeSucceeded(response: SseResponse): void {
    let sseEvent: string;
    try {
      sseEvent = buildSseSucceededEvent(response);
    } catch {
      sseEvent = buildSseFailedEvent("Failed to serialize result");
    }
    this.closeWriter(sseEvent);
  }

  /**
   * Write a failed result event and close the writer. Internal use only.
   */
  closeFailed(error: string): void {
    this.closeWriter(buildSseFailedEvent(error));
  }

  /**
   * Optionally write a final SSE event, then close the writer.
   */
  private closeWriter(finalEvent?: string): void {
    this.writeChain = this.writeChain
      .then(async () => {
        if (finalEvent) {
          await this.writeEncoded(finalEvent);
        }
        await this.writer.close();
      })
      .catch((err) => {
        this.onWriteError?.(err);
      });
  }

  /**
   * Close the writer without writing a result event. Used when the durable endpoint goes
   * async and the real result will arrive on the redirected stream.
   */
  end(): void {
    this.closeWriter();
  }
}

/** Synchronous ALS lookup for the stream tools (fast path). */
const getStreamToolsSync = (): Stream | undefined => {
  const ctx = getAsyncCtxSync();
  return ctx?.execution?.stream;
};

const getDeferredStreamTooling = async (): Promise<Stream | undefined> => {
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
      .catch(() => {
        // ALS initialization failure — already warned in als.ts.
        // push() is best-effort, so silently degrade.
      });
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
