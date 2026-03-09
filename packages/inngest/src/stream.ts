/**
 * Client-side utilities for consuming Inngest SSE streaming responses.
 *
 * Supports two consumption patterns:
 *
 * **Hooks + `.start()`** (recommended for most use cases):
 * ```ts
 * import { RunStream } from "inngest/durable-endpoints";
 *
 * const run = new RunStream<string>("/api/my-function");
 * const result = await run
 *   .onData((chunk) => console.log(chunk))
 *   .onRollback((removed, chunks) => console.log(`Rolled back`, removed))
 *   .onResult((data) => console.log("Done:", data))
 *   .start();
 * ```
 *
 * **Manual iteration** (for full control):
 * ```ts
 * const run = new RunStream("/api/my-function");
 * for await (const event of run) {
 *   switch (event.type) {
 *     case "data":
 *       console.log(event.data);
 *       break;
 *     case "rollback":
 *       console.log(`Rolling back ${event.count} chunks`);
 *       break;
 *   }
 * }
 * ```
 *
 * Both patterns maintain `run.chunks` — a built-in accumulator that
 * automatically tracks data and handles rollbacks.
 *
 * @module
 */

export type {
  SSEFrame,
  SSEMetadataFrame,
  SSERedirectFrame,
  SSEResultFrame,
  SSEStepFrame,
  SSEStreamFrame,
} from "./components/execution/streaming.ts";

import {
  iterSSE,
  parseSSEFrame,
  type SSEFrame,
} from "./components/execution/streaming.ts";

// ---------------------------------------------------------------------------
// subscribeToRun — low-level async generator yielding raw SSEFrame values
// ---------------------------------------------------------------------------

export interface SubscribeToRunOptions {
  headers?: Record<string, string>;
  body?: unknown;
  method?: string;
  signal?: AbortSignal;
}

/**
 * Subscribe to an Inngest streaming endpoint and yield typed SSE frames.
 *
 * This is the low-level primitive — most consumers should use {@link RunStream}
 * instead, which adds automatic rollback handling.
 *
 * Handles all plumbing automatically:
 * - Fetches the endpoint with `Accept: text/event-stream`
 * - Parses SSE frames into typed `SSEFrame` values
 * - On a `redirect` frame, transparently reconnects to the async checkpoint
 *   URL and continues yielding from there
 * - The generator ends when the stream closes
 */
export async function* subscribeToRun(
  endpoint: string,
  options?: SubscribeToRunOptions,
): AsyncGenerator<SSEFrame> {
  const headers = {
    Accept: "text/event-stream",
    ...options?.headers,
  };

  const fetchInit: RequestInit = { headers, signal: options?.signal };
  if (options?.body !== undefined) {
    fetchInit.method = options.method ?? "POST";
    fetchInit.headers = {
      ...headers,
      "Content-Type": "application/json",
    };
    fetchInit.body = JSON.stringify(options.body);
  } else if (options?.method) {
    fetchInit.method = options.method;
  }

  let res: Response;
  try {
    res = await fetch(endpoint, fetchInit);
  } catch (err) {
    throw new Error(
      `Failed to connect to streaming endpoint "${endpoint}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error("No response body");
  }

  yield* consumeStream(res.body, headers, options?.signal);
}

async function* consumeStream(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  let currentBody = body;

  // Iterative loop: on redirect, replace currentBody and restart
  // instead of recursing via yield*.
  for (;;) {
    let redirectUrl: string | undefined;

    for await (const raw of iterSSE(currentBody)) {
      const frame = parseSSEFrame(raw);
      if (!frame) continue;

      if (frame.type === "redirect") {
        const url = frame.url;
        if (!url) {
          throw new Error("Received redirect frame with no URL");
        }
        redirectUrl = url;
        break;
      }

      yield frame;
    }

    if (!redirectUrl) {
      // Stream ended normally (no redirect).
      return;
    }

    let asyncRes: Response;
    try {
      asyncRes = await fetch(redirectUrl, { headers, signal });
    } catch (err) {
      throw new Error(
        `Failed to follow redirect to "${redirectUrl}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!asyncRes.ok) {
      throw new Error(`HTTP ${asyncRes.status}: ${asyncRes.statusText}`);
    }
    if (!asyncRes.body) {
      return;
    }

    currentBody = asyncRes.body;
  }
}

// ---------------------------------------------------------------------------
// RunStream — high-level consumer with automatic rollback
// ---------------------------------------------------------------------------

/** Options for constructing a {@link RunStream}. */
export interface RunStreamOptions<TData = unknown>
  extends SubscribeToRunOptions {
  /**
   * Optional function to validate/transform raw data from the stream.
   * When provided, every `frame.data` value passes through this function
   * before being emitted or stored. When omitted, data is cast as `TData`.
   */
  parse?: (raw: unknown) => TData;
}

/** Hooks for declarative stream event handling. */
export interface RunStreamHooks<TData = unknown> {
  onData?: (chunk: TData, chunks: readonly TData[]) => void;
  onRollback?: (
    removed: readonly TData[],
    chunks: readonly TData[],
    stepId: string,
    attempt: number,
  ) => void;
  onResult?: (result: TData) => void;
  onConnected?: (runId: string, attempt: number) => void;
  onStepStarted?: (stepId: string) => void;
  onStepCompleted?: (stepId: string) => void;
  onStepErrored?: (
    stepId: string,
    error: string,
    willRetry: boolean,
    attempt: number,
  ) => void;
}

/** A data chunk pushed by the function via `stream.push()`. */
export type RunStreamDataEvent<TData = unknown> = {
  type: "data";
  data: TData;
};

/**
 * N chunks from the current step were invalidated and should be removed.
 *
 * Only data emitted during a step (between `step:started` and
 * `step:completed`/`step:errored`) is tracked for rollback. Data emitted
 * outside step boundaries is considered committed and will never be rolled
 * back.
 */
export type RunStreamRollbackEvent = {
  type: "rollback";
  count: number;
  stepId: string;
  /** The execution attempt (0-based) that failed and triggered this rollback. */
  attempt: number;
};

/** The function returned a final result. Terminal event. */
export type RunStreamResultEvent<TData = unknown> = {
  type: "result";
  data: TData;
};

/** The stream connected and run metadata is available. */
export type RunStreamConnectedEvent = {
  type: "connected";
  runId: string;
  attempt: number;
};

/** A step started executing. */
export type RunStreamStepStartedEvent = {
  type: "step:started";
  stepId: string;
};

/** A step completed successfully. */
export type RunStreamStepCompletedEvent = {
  type: "step:completed";
  stepId: string;
};

/** A step errored. Check `willRetry` to know if a rollback event follows. */
export type RunStreamStepErroredEvent = {
  type: "step:errored";
  stepId: string;
  error: string;
  willRetry: boolean;
  /** The execution attempt (0-based) that produced this error. */
  attempt: number;
};

/** Union of all events yielded by {@link RunStream}. */
export type RunStreamEvent<TData = unknown> =
  | RunStreamDataEvent<TData>
  | RunStreamRollbackEvent
  | RunStreamResultEvent<TData>
  | RunStreamConnectedEvent
  | RunStreamStepStartedEvent
  | RunStreamStepCompletedEvent
  | RunStreamStepErroredEvent;

/**
 * High-level consumer for Inngest SSE streaming responses with automatic
 * rollback on step retry.
 *
 * Wraps {@link subscribeToRun} and yields {@link RunStreamEvent} values.
 * When a step fails and will be retried, a `rollback` event is emitted
 * telling the consumer exactly how many data chunks to discard — no manual
 * checkpoint tracking required.
 *
 * A built-in accumulator ({@link RunStream.chunks}) automatically tracks
 * data and handles rollbacks, so consumers don't need to maintain their own
 * array.
 *
 * Only data emitted during a step (between `step:started` and
 * `step:completed`/`step:errored`) is tracked for rollback. Data emitted
 * outside step boundaries is considered committed and will never be rolled
 * back.
 *
 * @typeParam TData - The type of data chunks and the final result. Defaults
 * to `unknown`.
 *
 * @example Hooks + start
 * ```ts
 * const run = new RunStream<string>("/api/demo");
 * const result = await run
 *   .onData((chunk) => appendToUI(chunk))
 *   .onRollback((removed) => console.log("rolled back", removed))
 *   .start();
 * ```
 *
 * @example Manual iteration
 * ```ts
 * const run = new RunStream("/api/demo", { signal: controller.signal });
 * for await (const event of run) {
 *   if (event.type === "data") appendToUI(event.data);
 *   if (event.type === "rollback") removeLastN(event.count);
 * }
 * // run.chunks contains the final accumulated data
 * ```
 */
export class RunStream<TData = unknown>
  implements AsyncIterable<RunStreamEvent<TData>>
{
  private _endpoint: string;
  private _options?: RunStreamOptions<TData>;
  private _source?: () => AsyncGenerator<SSEFrame>;
  private _chunks: TData[] = [];
  private _hooks: RunStreamHooks<TData> = {};
  private _consumed = false;

  /** The run ID, available after the first `connected` event. */
  runId?: string;

  /** Accumulated data chunks, automatically maintained including rollbacks. */
  get chunks(): readonly TData[] {
    return this._chunks;
  }

  constructor(endpoint: string, options?: RunStreamOptions<TData>) {
    this._endpoint = endpoint;
    this._options = options;
  }

  /**
   * Create a `RunStream` with an injected SSE frame source, bypassing fetch.
   *
   * @internal — intended for testing only.
   */
  static _fromSource<T = unknown>(
    source: () => AsyncGenerator<SSEFrame>,
    options?: RunStreamOptions<T>,
    endpoint = "unused",
  ): RunStream<T> {
    const instance = new RunStream<T>(endpoint, options);
    instance._source = source;
    return instance;
  }

  // -- Hook registration (chaining) -----------------------------------------

  /**
   * Register a hook handler. Calling the same hook again replaces the
   * previous handler. All hook methods return `this` for chaining.
   */
  onData(fn: RunStreamHooks<TData>["onData"]): this {
    this._hooks.onData = fn;
    return this;
  }

  onRollback(fn: RunStreamHooks<TData>["onRollback"]): this {
    this._hooks.onRollback = fn;
    return this;
  }

  onResult(fn: RunStreamHooks<TData>["onResult"]): this {
    this._hooks.onResult = fn;
    return this;
  }

  onConnected(fn: RunStreamHooks<TData>["onConnected"]): this {
    this._hooks.onConnected = fn;
    return this;
  }

  onStepStarted(fn: RunStreamHooks<TData>["onStepStarted"]): this {
    this._hooks.onStepStarted = fn;
    return this;
  }

  onStepCompleted(fn: RunStreamHooks<TData>["onStepCompleted"]): this {
    this._hooks.onStepCompleted = fn;
    return this;
  }

  onStepErrored(fn: RunStreamHooks<TData>["onStepErrored"]): this {
    this._hooks.onStepErrored = fn;
    return this;
  }

  // -- Consumption -----------------------------------------------------------

  async *[Symbol.asyncIterator](): AsyncGenerator<RunStreamEvent<TData>> {
    if (this._consumed) {
      throw new Error("RunStream has already been consumed");
    }
    this._consumed = true;
    yield* this._pump();
  }

  /**
   * Drive the stream to completion, firing registered hooks along the way.
   *
   * @returns An object containing the final result data, or `undefined` if
   * the stream ended without a result event.
   */
  async start(): Promise<{ result: TData } | undefined> {
    let result: { result: TData } | undefined;
    for await (const event of this) {
      if (event.type === "result") {
        result = { result: event.data };
      }
    }
    return result;
  }

  // -- Internal helpers ------------------------------------------------------

  private _parseData(raw: unknown): TData {
    if (this._options?.parse) {
      return this._options.parse(raw);
    }
    return raw as TData;
  }

  /**
   * Splice the last `count` chunks from the accumulator and return a
   * rollback event, firing the hook along the way.
   */
  private _rollback(
    count: number,
    stepId: string,
    attempt: number,
  ): RunStreamRollbackEvent {
    const removed = this._chunks.splice(-count);
    this._hooks.onRollback?.(removed, this.chunks, stepId, attempt);
    return { type: "rollback", count, stepId, attempt };
  }

  // -- Internal pump ---------------------------------------------------------

  private async *_pump(): AsyncGenerator<RunStreamEvent<TData>> {
    let inStep = false;
    let chunksSinceStepStart = 0;
    let currentStepId = "";
    let currentAttempt = 0;

    const source = this._source
      ? this._source()
      : subscribeToRun(this._endpoint, this._options);

    for await (const frame of source) {
      switch (frame.type) {
        case "metadata":
          this.runId = frame.run_id;
          currentAttempt = frame.attempt;
          this._hooks.onConnected?.(frame.run_id, frame.attempt);
          yield {
            type: "connected",
            runId: frame.run_id,
            attempt: frame.attempt,
          };
          break;

        case "step":
          if (frame.status === "running") {
            inStep = true;
            chunksSinceStepStart = 0;
            currentStepId = frame.id;
            this._hooks.onStepStarted?.(frame.id);
            yield { type: "step:started", stepId: frame.id };
          } else if (frame.status === "completed") {
            inStep = false;
            chunksSinceStepStart = 0;
            this._hooks.onStepCompleted?.(frame.id);
            yield { type: "step:completed", stepId: frame.id };
          } else if (frame.status === "errored") {
            const willRetry = frame.will_retry === true;
            const attempt = frame.attempt ?? currentAttempt;
            this._hooks.onStepErrored?.(
              frame.id,
              frame.error ?? "Unknown error",
              willRetry,
              attempt,
            );
            yield {
              type: "step:errored",
              stepId: frame.id,
              error: frame.error ?? "Unknown error",
              willRetry,
              attempt,
            };
            if (willRetry && chunksSinceStepStart > 0) {
              yield this._rollback(chunksSinceStepStart, frame.id, attempt);
            }
            inStep = false;
            chunksSinceStepStart = 0;
          }
          break;

        case "stream": {
          const data = this._parseData(frame.data);
          if (inStep) chunksSinceStepStart++;
          this._chunks.push(data);
          this._hooks.onData?.(data, this.chunks);
          yield { type: "data", data };
          break;
        }

        case "result": {
          const data = this._parseData(frame.data);
          this._hooks.onResult?.(data);
          yield { type: "result", data };
          break;
        }
      }
    }

    // Stream closed while a step was still in progress — emit synthetic
    // error and rollback so consumers can clean up partial state.
    if (inStep && chunksSinceStepStart > 0) {
      this._hooks.onStepErrored?.(
        currentStepId,
        "Stream disconnected during step execution",
        false,
        currentAttempt,
      );
      yield {
        type: "step:errored",
        stepId: currentStepId,
        error: "Stream disconnected during step execution",
        willRetry: false,
        attempt: currentAttempt,
      };
      yield this._rollback(chunksSinceStepStart, currentStepId, currentAttempt);
    }
  }
}
