import { getAsyncCtx, getAsyncCtxSync } from "./execution/als.ts";
import {
  buildSSERedirectFrame,
  buildSSEResultFrame,
  buildSSEStreamFrame,
} from "./execution/streaming.ts";

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
   * Pipe a `ReadableStream` to the client, writing each chunk as an SSE stream
   * frame. Resolves with the concatenated content of all chunks when the
   * readable is fully consumed.
   *
   * Outside of an Inngest execution context this resolves with an empty string.
   */
  pipe(readable: ReadableStream): Promise<string>;
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

    this.writeChain = this.writeChain
      .then(() => this.writer.write(this.encoder.encode(frame)))
      .catch(() => {
        // Writer errored (e.g. stream closed) — swallow so the chain
        // doesn't break and subsequent writes fail gracefully.
      });
  }

  /**
   * Read all chunks from `readable`, write each as an SSE stream frame, and
   * return the concatenated content of all chunks.
   */
  async pipe(readable: ReadableStream): Promise<string> {
    this.activate();
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // value may be a string or Uint8Array depending on the stream source
        const chunk = typeof value === "string" ? value : decoder.decode(value);
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
            // Writer errored — swallow to keep the read loop draining
            // so we still collect all chunks for the return value.
          });
        await this.writeChain;
      }
    } finally {
      reader.releaseLock();
    }

    return chunks.join("");
  }

  /**
   * Write a redirect frame and close the writer. Tells the client that
   * execution has switched to async mode. Internal use only.
   */
  redirect(data: { run_id: string; token: string; url?: string }): void {
    const frame = buildSSERedirectFrame(data);

    this.writeChain = this.writeChain
      .then(() => this.writer.write(this.encoder.encode(frame)))
      .then(() => this.writer.close())
      .catch(() => {
        // Writer already errored/closed — nothing to do.
      });
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

    this.writeChain = this.writeChain
      .then(() => this.writer.write(this.encoder.encode(frame)))
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
  pipe: async (readable) => {
    const syncStream = getStreamToolsSync();
    if (syncStream) {
      return syncStream.pipe(readable);
    }

    const s = await getDeferredStreamTooling();
    return s ? s.pipe(readable) : "";
  },
};
