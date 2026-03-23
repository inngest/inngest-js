import { getAsyncCtx, getAsyncCtxSync } from "./execution/als.ts";
import {
  buildSseRedirectFrame,
  buildSseResultFrame,
  buildSseStepFrame,
  buildSseStreamFrame,
  type SseStepFrame,
  type StepErrorData,
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

  /**
   * Resolve the current step ID for stream frames. Returns the executing
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
   * Enqueue a pre-built SSE frame string onto the write chain.
   */
  private enqueue(frame: string): void {
    this.writeChain = this.writeChain
      .then(() => this.writer.write(this.encoder.encode(frame)))
      .catch(() => {
        // Writer errored (e.g. stream closed) — swallow so the chain
        // doesn't break and subsequent writes fail gracefully.
      });
  }

  /**
   * Emit a step lifecycle SSE frame (`step:running`, `step:completed`,
   * `step:errored`). Internal use only — called by the execution engine.
   */
  stepLifecycle(stepId: string, status: "running"): void;
  stepLifecycle(stepId: string, status: "completed"): void;
  stepLifecycle(stepId: string, status: "errored", data: StepErrorData): void;
  stepLifecycle(
    stepId: string,
    status: SseStepFrame["status"],
    data?: StepErrorData,
  ): void {
    this.enqueue(buildSseStepFrame(stepId, status, data));
  }

  /**
   * Write a single SSE stream frame containing `data`. The current step's
   * hashed ID is automatically included as step_id for rollback tracking.
   */
  push(data: unknown): void {
    this.activate();

    const stepId = this.currentStepId();

    let frame: string;
    try {
      frame = buildSseStreamFrame(data, stepId);
    } catch {
      // data is not JSON-serializable (e.g. circular reference) — skip
      return;
    }

    this.enqueue(frame);
  }

  /**
   * Pipe a source to the client, writing each chunk as an SSE stream frame.
   * Returns the concatenated content of all chunks.
   */
  async pipe(source: PipeSource): Promise<string> {
    this.activate();

    // Resolve the source into an AsyncIterable<string>.
    // Check ReadableStream first — on Node 18+ ReadableStream implements
    // Symbol.asyncIterator, so the instanceof check must come before
    // the async-iterable duck-type test.
    const iterable: AsyncIterable<string> =
      source instanceof ReadableStream
        ? this.readableToAsyncIterable(source)
        : typeof source === "function"
          ? source()
          : source;

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
   * stream frame and collecting the concatenated result.
   */
  private async pipeIterable(source: AsyncIterable<string>): Promise<string> {
    const stepId = this.currentStepId();
    const chunks: string[] = [];

    for await (const chunk of source) {
      chunks.push(chunk);

      let frame: string;
      try {
        frame = buildSseStreamFrame(chunk, stepId);
      } catch {
        continue;
      }

      this.writeChain = this.writeChain
        .then(() => this.writer.write(this.encoder.encode(frame)))
        .catch(() => {
          // Writer errored — swallow to keep the read loop draining
          // so we still collect all chunks for the return value.
        });
      await this.writeChain;
    }

    return chunks.join("");
  }

  /**
   * Write a redirect info frame. Tells the client where to reconnect if the
   * DE goes async. Does NOT close the writer — more stream frames may follow
   * before the DE actually switches to async mode. Internal use only.
   */
  sendRedirectInfo(data: {
    run_id: string;
    token: string;
    url?: string;
  }): void {
    this.enqueue(buildSseRedirectFrame(data));
  }

  /**
   * Write a terminal result frame and close the writer. Internal use only.
   */
  close(resultData?: unknown): void {
    let frame: string;
    try {
      frame = buildSseResultFrame(resultData);
    } catch {
      frame = buildSseResultFrame({ error: "Failed to serialize result" });
    }

    this.writeChain = this.writeChain
      .then(() => this.writer.write(this.encoder.encode(frame)))
      .then(() => this.writer.close())
      .catch(() => {
        // Writer already errored/closed — nothing to do.
      });
  }

  /**
   * Close the writer without writing a result frame. Used when the DE goes
   * async and the real result will arrive on the redirected stream.
   */
  end(): void {
    this.writeChain = this.writeChain
      .then(() => this.writer.close())
      .catch(() => {
        // Writer already errored/closed — nothing to do.
      });
  }
}

/**
 * Try to get the stream tools synchronously first (fast path), falling back
 * to the async ALS lookup. The sync path is available after the first ALS
 * initialization and is critical for fire-and-forget `push()` calls that
 * must activate the stream before the next microtask tick.
 */
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
        // Suppress: outside an execution context or ALS lookup failed.
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
