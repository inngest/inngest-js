/**
 * Client-side streaming utilities for consuming Durable Endpoint SSE streams.
 *
 * This module provides `subscribeToRun()` (low-level async generator) and
 * `RunStream` (high-level hook-based API) for consuming SSE streams produced
 * by Inngest Durable Endpoints.
 */

import {
  iterSSE,
  parseSSEFrame,
  type SSEFrame,
} from "./components/execution/streaming.ts";

// ---------------------------------------------------------------------------
// subscribeToRun — low-level async generator
// ---------------------------------------------------------------------------

export interface SubscribeToRunOptions {
  /** The URL of the Durable Endpoint to connect to. */
  url: string;
  /** Optional AbortSignal to cancel the stream. */
  signal?: AbortSignal;
  /** Optional fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Low-level async generator that fetches an SSE endpoint, parses frames,
 * and follows `inngest.redirect_info` frames transparently.
 */
export async function* subscribeToRun(
  opts: SubscribeToRunOptions,
): AsyncGenerator<SSEFrame> {
  const fetchFn = opts.fetch ?? globalThis.fetch;

  yield* consumeStream(opts.url, fetchFn, opts.signal);
}

async function* consumeStream(
  url: string,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  let currentUrl: string | undefined = url;

  while (currentUrl) {
    const res = await fetchFn(currentUrl, {
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!res.ok) {
      throw new Error(`Stream request failed: ${res.status} ${res.statusText}`);
    }

    if (!res.body) {
      throw new Error("No response body");
    }

    let redirectUrl: string | undefined;

    for await (const raw of iterSSE(res.body)) {
      const frame = parseSSEFrame(raw);
      if (!frame) continue;

      if (frame.type === "inngest.redirect_info") {
        redirectUrl = frame.url;
        yield frame;
        // Don't break — keep consuming remaining frames from this response
        continue;
      }

      yield frame;
    }

    // Follow redirect if we got one; otherwise we're done
    if (redirectUrl) {
      currentUrl = redirectUrl;
      redirectUrl = undefined;
    } else {
      currentUrl = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// RunStream — high-level hook-based API
// ---------------------------------------------------------------------------

export interface RunStreamOptions<TData = unknown> {
  /** The URL of the Durable Endpoint to connect to. */
  url: string;
  /** Optional AbortSignal to cancel the stream. */
  signal?: AbortSignal;
  /** Optional fetch implementation. */
  fetch?: typeof globalThis.fetch;
  /** Optional parse function to transform raw data chunks. */
  parse?: (data: unknown) => TData;
}

type DataHook<TData> = (data: TData) => void;
type RollbackHook<TData> = (rolledBack: TData[]) => void;
type ResultHook = (data: unknown) => void;
type StepHook = (stepId: string, data?: unknown) => void;
type ErrorHook = (
  stepId: string,
  info: { willRetry: boolean; error: string; attempt: number },
) => void;
type MetadataHook = (runId: string, attempt: number) => void;
type DoneHook = () => void;

/**
 * A high-level streaming client that provides a hook-based API for consuming
 * Durable Endpoint SSE streams.
 *
 * Features:
 * - `.onData()`, `.onRollback()`, `.onResult()` hooks
 * - AsyncIterable interface (for await...of)
 * - Built-in accumulator with automatic rollback on retry
 * - Optional `parse` function for transforming raw chunks
 */
export class RunStream<TData = unknown> {
  private _chunks: TData[] = [];
  private _consumed = false;
  private _source: AsyncIterable<SSEFrame> | undefined;

  private _dataHooks: DataHook<TData>[] = [];
  private _rollbackHooks: RollbackHook<TData>[] = [];
  private _resultHooks: ResultHook[] = [];
  private _stepRunningHooks: StepHook[] = [];
  private _stepCompletedHooks: StepHook[] = [];
  private _stepErroredHooks: ErrorHook[] = [];
  private _metadataHooks: MetadataHook[] = [];
  private _doneHooks: DoneHook[] = [];

  private _parseFn: (data: unknown) => TData;

  constructor(private opts: RunStreamOptions<TData>) {
    this._parseFn = opts.parse ?? ((d: unknown) => d as TData);
  }

  /** All accumulated data chunks (automatically rolled back on retry). */
  get chunks(): readonly TData[] {
    return this._chunks;
  }

  onData(fn: DataHook<TData>): this {
    this._dataHooks.push(fn);
    return this;
  }

  onRollback(fn: RollbackHook<TData>): this {
    this._rollbackHooks.push(fn);
    return this;
  }

  onResult(fn: ResultHook): this {
    this._resultHooks.push(fn);
    return this;
  }

  onStepRunning(fn: StepHook): this {
    this._stepRunningHooks.push(fn);
    return this;
  }

  onStepCompleted(fn: StepHook): this {
    this._stepCompletedHooks.push(fn);
    return this;
  }

  onStepErrored(fn: ErrorHook): this {
    this._stepErroredHooks.push(fn);
    return this;
  }

  onMetadata(fn: MetadataHook): this {
    this._metadataHooks.push(fn);
    return this;
  }

  onDone(fn: DoneHook): this {
    this._doneHooks.push(fn);
    return this;
  }

  /**
   * Inject a pre-built source for testing. Skips the real fetch.
   */
  _fromSource(source: AsyncIterable<SSEFrame>): this {
    this._source = source;
    return this;
  }

  /**
   * Start consuming the stream. Returns a promise that resolves when the
   * stream is fully consumed. Hooks fire as side effects.
   */
  async start(): Promise<void> {
    const gen = this._consume();
    while (true) {
      const { done } = await gen.next();
      if (done) break;
    }
  }

  /**
   * AsyncIterable interface — yields parsed data chunks.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<TData> {
    yield* this._consume();
  }

  private _resolveSource(): AsyncIterable<SSEFrame> {
    return (
      this._source ??
      subscribeToRun({
        url: this.opts.url,
        signal: this.opts.signal,
        fetch: this.opts.fetch,
      })
    );
  }

  /**
   * Core processing loop. Processes SSE frames, fires hooks, yields parsed
   * data chunks, and handles rollback on step errors / disconnects.
   */
  private async *_consume(): AsyncGenerator<TData> {
    if (this._consumed) {
      throw new Error("RunStream has already been consumed");
    }
    this._consumed = true;

    const source = this._resolveSource();

    let inStep = false;
    let chunksSinceStepStart = 0;
    let currentStepId: string | undefined;
    // Label the outer loop so we can break out of it from inside the switch.
    // This is necessary because `break` inside a `switch` only exits the
    // switch, and after receiving `inngest.result` the underlying SSE
    // connection may stay open — meaning `source.next()` would block forever
    // if we relied on the loop's next iteration to check a flag.
    outer: for await (const frame of source) {
      switch (frame.type) {
        case "stream": {
          const parsed = this._parseFn(frame.data);
          this._chunks.push(parsed);
          chunksSinceStepStart++;
          for (const fn of this._dataHooks) fn(parsed);
          yield parsed;
          break;
        }
        case "inngest.step": {
          if (frame.status === "running") {
            inStep = true;
            chunksSinceStepStart = 0;
            currentStepId = frame.step_id;
            for (const fn of this._stepRunningHooks) fn(frame.step_id);
          } else if (frame.status === "completed") {
            inStep = false;
            currentStepId = undefined;
            for (const fn of this._stepCompletedHooks)
              fn(frame.step_id, frame.data);
          } else if (frame.status === "errored") {
            const data = frame.data as Record<string, unknown> | undefined;
            if (chunksSinceStepStart > 0) {
              const rolledBack = this._chunks.splice(-chunksSinceStepStart);
              for (const fn of this._rollbackHooks) fn(rolledBack);
            }
            inStep = false;
            currentStepId = undefined;
            for (const fn of this._stepErroredHooks)
              fn(frame.step_id, {
                willRetry: (data?.will_retry as boolean) ?? false,
                error: (data?.error as string) ?? "unknown",
                attempt: (data?.attempt as number) ?? 0,
              });
          }
          break;
        }
        case "inngest.result":
          for (const fn of this._resultHooks) fn(frame.data);
          break outer;
        case "inngest.metadata":
          for (const fn of this._metadataHooks)
            fn(frame.run_id, frame.attempt);
          break;
        default:
          break;
      }
    }

    // Synthesize rollback if disconnected mid-step
    if (inStep && chunksSinceStepStart > 0) {
      const rolledBack = this._chunks.splice(-chunksSinceStepStart);
      for (const fn of this._rollbackHooks) fn(rolledBack);
      for (const fn of this._stepErroredHooks)
        fn(currentStepId ?? "unknown", {
          willRetry: false,
          error: "stream disconnected",
          attempt: 0,
        });
    }

    for (const fn of this._doneHooks) fn();
  }
}
