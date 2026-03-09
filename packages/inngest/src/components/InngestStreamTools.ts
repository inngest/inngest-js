import { getAsyncCtx, getAsyncCtxSync } from "./execution/als.ts";
import {
  buildSSERedirectFrame,
  buildSSEResultFrame,
  buildSSEStepFrame,
  buildSSEStreamFrame,
} from "./execution/streaming.ts";

/**
 * A source that `pipe()` can consume: a `ReadableStream`, an
 * `AsyncIterable<string>`, or a zero-arg function that returns either.
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
   * Push data to the client as an SSE stream frame. Fire-and-forget from the
   * caller's perspective.
   *
   * Outside of an Inngest execution context this is a silent no-op (graceful
   * degradation).
   */
  push(data: unknown): void;

  /**
   * Pipe a source to the client, writing each chunk as an SSE stream frame.
   * Resolves with the concatenated content of all chunks when the source is
   * fully consumed.
   *
   * Accepts a `ReadableStream`, an `AsyncIterable<string>`, or an async
   * generator function that yields strings.
   *
   * @example
   * ```ts
   * // ReadableStream (existing)
   * const text = await stream.pipe(readable);
   *
   * // AsyncIterable directly
   * const text = await stream.pipe(result.textStream);
   *
   * // Generator function for transform/extract
   * const text = await stream.pipe(async function* () {
   *   for await (const event of anthropicStream) {
   *     if (event.type === "content_block_delta") {
   *       yield event.delta.text;
   *     }
   *   }
   * });
   * ```
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
  onActivated?: () => void;

  constructor() {
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
   * HTTP response) read SSE frames from here.
   */
  get readable(): ReadableStream<Uint8Array> {
    return this.transform.readable;
  }

  private activate(): void {
    if (!this._activated) {
      this._activated = true;
      this.onActivated?.();
    }
  }

  /**
   * Enqueue a pre-built frame string onto the write chain and optionally
   * close the writer afterwards. All write-side methods (except `pipe`)
   * funnel through here to avoid duplicating the chain pattern.
   */
  private enqueue(frame: string, andClose = false): void {
    this.writeChain = this.writeChain
      .then(() => this.writer.write(this.encoder.encode(frame)))
      .then(() => (andClose ? this.writer.close() : undefined))
      .catch(() => {
        // Writer errored/closed — swallow so the chain stays healthy.
      });
  }

  /**
   * Write a single SSE stream frame containing `data`.
   */
  push(data: unknown): void {
    this.activate();

    let frame: string;
    try {
      frame = buildSSEStreamFrame(data);
    } catch {
      // data is not JSON-serializable (e.g. circular reference) — skip
      return;
    }

    this.enqueue(frame);
  }

  /**
   * Pipe a source to the client, writing each chunk as an SSE stream frame,
   * and return the concatenated content of all chunks.
   */
  async pipe(source: PipeSource): Promise<string> {
    // Resolve the source to a concrete iterable or ReadableStream.
    const resolved = typeof source === "function" ? source() : source;

    // ReadableStream first — on Node 18+ ReadableStream implements
    // Symbol.asyncIterator, so we must check instanceof before the
    // protocol check to avoid misrouting.
    if (resolved instanceof ReadableStream) {
      return this.pipeIterable(this.readableToAsyncIterable(resolved));
    }

    // AsyncIterable path (includes async generators).
    if (Symbol.asyncIterator in resolved) {
      return this.pipeIterable(resolved);
    }

    throw new TypeError(
      "stream.pipe() requires a ReadableStream, AsyncIterable<string>, or a function returning one.",
    );
  }

  /**
   * Convert a `ReadableStream` into an `AsyncIterable<string>`, decoding
   * `Uint8Array` chunks along the way.
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

  private async pipeIterable(source: AsyncIterable<string>): Promise<string> {
    this.activate();
    const chunks: string[] = [];

    for await (const chunk of source) {
      chunks.push(chunk);

      let frame: string;
      try {
        frame = buildSSEStreamFrame(chunk);
      } catch {
        continue;
      }

      await this.writeChain;
      this.writeChain = this.writer
        .write(this.encoder.encode(frame))
        .catch(() => {
          // Writer errored — keep draining so the return value is accurate.
        });
      await this.writeChain;
    }

    return chunks.join("");
  }

  /**
   * Write a step lifecycle frame. Internal use only.
   */
  stepLifecycle(data: {
    id: string;
    status: "running" | "completed" | "errored";
    error?: string;
    will_retry?: boolean;
    attempt?: number;
  }): void {
    let frame: string;
    try {
      frame = buildSSEStepFrame(data);
    } catch {
      return;
    }

    this.enqueue(frame);
  }

  /**
   * Close the writer without a terminal result frame. Used when a step
   * fails and the execution will be retried — the POST body ends but the
   * client stream (backed by the Go buffer) continues across retries.
   */
  closeForRetry(): void {
    this.writeChain = this.writeChain
      .then(() => this.writer.close())
      .catch(() => {});
  }

  /**
   * Write a redirect frame and close the writer. Tells the client that
   * execution has switched to async mode. Internal use only.
   */
  redirect(data: { run_id: string; token: string; url?: string }): void {
    const frame = buildSSERedirectFrame(data);
    this.enqueue(frame, true);
  }

  /**
   * Write a terminal result frame and close the writer. Internal use only.
   */
  close(resultData?: unknown): void {
    let frame: string;
    try {
      frame = buildSSEResultFrame(resultData);
    } catch {
      frame = buildSSEResultFrame({ error: "Failed to serialize result" });
    }

    this.enqueue(frame, true);
  }
}

/**
 * Resolve the `InngestStream` from ALS synchronously (fast path) or
 * asynchronously (fallback while ALS is still initializing).
 */
const getStreamSync = (): InngestStream | undefined => {
  return getAsyncCtxSync()?.execution?.stream;
};

const getStreamAsync = async (): Promise<InngestStream | undefined> => {
  const ctx = await getAsyncCtx();
  return ctx?.execution?.stream;
};

/**
 * A generic set of stream tools that can be used without typing information
 * about the client used to create them.
 *
 * These tools use AsyncLocalStorage to track the context in which they are
 * used. Outside of an Inngest execution context, `push()` is a silent no-op
 * and `pipe()` resolves immediately.
 */
export const stream: StreamTools = {
  push: (data) => {
    // Fast synchronous path: resolve the ALS store without going through
    // a promise chain. This ensures the stream is activated immediately,
    // before the next step's microtask can fire.
    const s = getStreamSync();
    if (s) {
      s.push(data);
      return;
    }

    // Fallback: ALS not yet initialized (first import still resolving).
    void getStreamAsync()
      .then((s) => s?.push(data))
      .catch(() => {
        // Suppress: outside an execution context or ALS lookup failed.
      });
  },
  pipe: async (source) => {
    const s = getStreamSync();
    if (s) return s.pipe(source);

    const asyncStream = await getStreamAsync();
    if (asyncStream) return asyncStream.pipe(source);

    return "";
  },
};
