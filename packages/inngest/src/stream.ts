/**
 * Client-side streaming utilities for consuming Durable Endpoint SSE streams.
 *
 * This module provides `subscribeToRun()` (low-level async generator) and
 * `streamRun()` (high-level hook-based API) for consuming SSE streams produced
 * by Inngest Durable Endpoints.
 */

import {
  iterSse,
  parseSseEvent,
  type SseEvent,
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
 * Low-level async generator that fetches an SSE endpoint, parses SSE events,
 * and follows `inngest.redirect_info` events transparently.
 */
export async function* subscribeToRun(
  opts: SubscribeToRunOptions,
): AsyncGenerator<SseEvent> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  let currentUrl: string | undefined = opts.url;

  while (currentUrl) {
    const res = await fetchFn(currentUrl, {
      headers: { Accept: "text/event-stream" },
      signal: opts.signal,
    });

    if (!res.ok) {
      throw new Error(`Stream request failed: ${res.status} ${res.statusText}`);
    }

    if (!res.body) {
      throw new Error("No response body");
    }

    let redirectUrl: string | undefined;

    for await (const raw of iterSse(res.body)) {
      const sseEvent = parseSseEvent(raw);
      if (!sseEvent) continue;

      if (sseEvent.type === "inngest.redirect_info") {
        redirectUrl = sseEvent.url;
        yield sseEvent;
        // Don't break — keep consuming remaining events from this response
        continue;
      }

      yield sseEvent;
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
// streamRun — high-level hook-based API
// ---------------------------------------------------------------------------

export interface RunStreamOptions<TData = unknown> {
  /** The URL of the Durable Endpoint to connect to. */
  url: string;
  /** Optional AbortSignal to cancel the stream. */
  signal?: AbortSignal;
  /** Optional fetch implementation. */
  fetch?: typeof globalThis.fetch;
  /** Optional parse function to transform raw data chunks. */
  parse?: (data: unknown) => TData; // TODO: is this needed?
  /** Called for each parsed data chunk. */
  onData?: (args: { data: TData; hashedStepId?: string }) => void;
  /** Called when chunks are rolled back due to a step error or disconnect. */
  onRollback?: (args: { count: number }) => void;
  /**
   * Called when the function completes successfully. The data is `unknown`
   * because SSE transport erases the original return type.
   */
  onFunctionCompleted?: (args: { data: unknown }) => void;
  /** Called when a step begins running. */
  onStepRunning?: (args: { hashedStepId: string }) => void;
  /**
   * Called when a step completes successfully. The data is `unknown` because
   * SSE transport erases the original step output type.
   */
  onStepCompleted?: (args: { hashedStepId: string }) => void;
  /** Called when run metadata is received. */
  onMetadata?: (args: { runId: string }) => void;
  /** Called when the stream is fully consumed (including on abort or error). */
  onDone?: () => void;
  /** Called when a stream-level error occurs (network failure, non-200, etc.). */
  onStreamError?: (args: { error: unknown }) => void;
}

/**
 * Create a stream that connects to a Durable Endpoint SSE stream.
 *
 * The returned object is both awaitable (hooks-only) and async-iterable
 * (for consuming chunks directly):
 *
 * @example Hooks-only — just `await` the stream
 * ```ts
 * import { streamRun } from "inngest/experimental/durable-endpoints";
 *
 * await streamRun<string>("/api/demo", {
 *   parse: (d) => (typeof d === "string" ? d : JSON.stringify(d)),
 *   onData: (chunk) => console.log(chunk),
 *   onFunctionCompleted: ({ data }) => console.log("done:", data),
 * });
 * ```
 *
 * @example Iteration — consume chunks directly
 * ```ts
 * for await (const chunk of streamRun<string>("/api/demo")) {
 *   console.log(chunk);
 * }
 * ```
 */
export function streamRun<TData = unknown>(
  url: string,
  opts?: Omit<RunStreamOptions<TData>, "url">,
): RunStream<TData> {
  return new RunStream({ ...opts, url });
}

/**
 * Internal streaming client. Use `streamRun()` to create instances.
 *
 * @internal
 */
export class RunStream<TData = unknown> {
  private _tagged: Array<{ data: TData; stepId?: string }> = [];
  private _chunks: TData[] = [];
  private _consumed = false;
  private _source: AsyncIterable<SseEvent> | undefined;

  private _parseFn: (data: unknown) => TData;

  constructor(private opts: RunStreamOptions<TData>) {
    this._parseFn = opts.parse ?? ((d: unknown) => d as TData);
  }

  /** All accumulated data chunks (automatically rolled back on retry). */
  get chunks(): readonly TData[] {
    return this._chunks;
  }

  private _pushChunk(data: TData, stepId?: string): void {
    this._tagged.push({ data, stepId });
    this._chunks.push(data);
  }

  /**
   * Remove all chunks belonging to the given step ID and return how many
   * were removed.
   */
  private _rollbackStepId(stepId: string): number {
    const before = this._tagged.length;
    this._tagged = this._tagged.filter((c) => c.stepId !== stepId);
    this._chunks = this._tagged.map((c) => c.data);
    return before - this._tagged.length;
  }

  /**
   * Mark all chunks belonging to `stepId` as committed by clearing their
   * stepId tag. Committed chunks can never be rolled back — even if a
   * same-named step retries and errors later, only uncommitted chunks from
   * that retry will be removed.
   */
  private _commitStepId(stepId: string): void {
    for (const entry of this._tagged) {
      if (entry.stepId === stepId) {
        entry.stepId = undefined;
      }
    }
  }

  /**
   * Inject a pre-built source for testing. Skips the real fetch.
   * @internal
   */
  _fromSource(source: AsyncIterable<SseEvent>): this {
    this._source = source;
    return this;
  }

  /**
   * Makes the stream awaitable. `await streamRun(url, opts)` consumes the
   * stream using hooks only (no manual iteration needed).
   */
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: // biome-ignore lint/suspicious/noConfusingVoidType: matches PromiseLike signature
    ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): Promise<TResult1 | TResult2> {
    const drain = async (): Promise<void> => {
      const gen = this._consume();
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }
    };

    return drain().then(onfulfilled, onrejected);
  }

  /**
   * AsyncIterable interface — yields parsed data chunks.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<TData> {
    yield* this._consume();
  }

  private _resolveSource(): AsyncIterable<SseEvent> {
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
   * Core processing loop. Processes SSE events, fires hooks, yields parsed
   * data chunks, and handles rollback on step errors / disconnects.
   */
  private async *_consume(): AsyncGenerator<TData> {
    if (this._consumed) {
      throw new Error("RunStream has already been consumed");
    }
    this._consumed = true;

    const source = this._resolveSource();

    // Track which steps are currently executing (supports parallel steps).
    const inFlightSteps = new Set<string>();

    try {
      // Label the outer loop so we can break out of it from inside the switch.
      // This is necessary because `break` inside a `switch` only exits the
      // switch, and after receiving `inngest.result` the underlying SSE
      // connection may stay open — meaning `source.next()` would block forever
      // if we relied on the loop's next iteration to check a flag.
      outer: for await (const sseEvent of source) {
        switch (sseEvent.type) {
          case "stream": {
            const parsed = this._parseFn(sseEvent.data);
            this._pushChunk(parsed, sseEvent.stepId);
            this.opts.onData?.({ data: parsed, hashedStepId: sseEvent.stepId });
            yield parsed;
            break;
          }
          case "inngest.step": {
            if (sseEvent.status === "running") {
              inFlightSteps.add(sseEvent.stepId);
              this.opts.onStepRunning?.({ hashedStepId: sseEvent.stepId });
            } else if (sseEvent.status === "completed") {
              inFlightSteps.delete(sseEvent.stepId);
              this._commitStepId(sseEvent.stepId);
              this.opts.onStepCompleted?.({
                hashedStepId: sseEvent.stepId,
              });
            } else if (sseEvent.status === "errored") {
              inFlightSteps.delete(sseEvent.stepId);
              const count = this._rollbackStepId(sseEvent.stepId);
              if (count > 0) {
                this.opts.onRollback?.({ count });
              }
            }
            break;
          }
          case "inngest.result":
            // Only "succeeded" fires a hook. Failed results are an
            // implementation detail — endpoint authors handle errors
            // server-side and control the response they return.
            if (sseEvent.status === "succeeded") {
              this.opts.onFunctionCompleted?.({ data: sseEvent.data });
            }
            break outer;
          case "inngest.metadata":
            this.opts.onMetadata?.({ runId: sseEvent.runId });
            break;
          default:
            break;
        }
      }

      // Synthesize rollback for any steps still in flight on disconnect.
      for (const stepId of inFlightSteps) {
        const count = this._rollbackStepId(stepId);
        if (count > 0) {
          this.opts.onRollback?.({ count });
        }
      }
    } catch (error) {
      this.opts.onStreamError?.({ error });
      throw error;
    } finally {
      this.opts.onDone?.();
    }
  }
}
