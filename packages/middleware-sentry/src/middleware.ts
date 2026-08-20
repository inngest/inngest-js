import * as Sentry from "@sentry/core";
import type { Span } from "@sentry/types";
import { Middleware } from "inngest";

/**
 * Options used to configure the Sentry middleware.
 */
export interface SentryMiddlewareOptions {
  /**
   * If `true`, will not automatically flush events after each function run.
   * This can be useful if you want to control when events are sent to Sentry,
   * or leave it to Sentry's default behavior.
   *
   * By default, automatic flushing is enabled to ensure that events are sent in
   * serverless environments where the runtime may be terminated if the function
   * has returned a value.
   *
   * @default false
   */
  disableAutomaticFlush?: boolean;

  /**
   * If `true`, exceptions are only captured on the final attempt of a step or
   * function run (when retries are exhausted or the error is non-retriable).
   * Intermediate retry attempts will still set span error status and add
   * breadcrumbs, but won't create Sentry events.
   *
   * This reduces noise for transient errors that resolve on retry.
   *
   * @default true
   */
  onlyCaptureFinalAttempt?: boolean;

  /**
   * If `true`, step-level errors are captured as separate Sentry events in
   * addition to function-level errors. This gives granular visibility into
   * which step failed, but can produce duplicate events when a step error
   * propagates to the function level.
   *
   * When `false`, step errors are still recorded as error spans and breadcrumbs
   * (visible in traces), but only function-level errors produce Sentry events.
   *
   * @default false
   */
  captureStepErrors?: boolean;
}

/**
 * Captures errors and performance data from Inngest functions and sends them to
 * Sentry.
 *
 * Can be used directly as a middleware class or configured via the
 * {@link sentryMiddleware} factory function.
 *
 * This imports Sentry directly and relies on it already being initialized using
 * `Sentry.init()`. For more information on how to configure Sentry, see the
 * [Sentry documentation](https://docs.sentry.io/platforms/node/).
 */
export class SentryMiddleware extends Middleware.BaseMiddleware {
  readonly id = "inngest:sentry";

  /**
   * See {@link SentryMiddlewareOptions} for more information.
   */
  protected disableAutomaticFlush = false;

  /**
   * See {@link SentryMiddlewareOptions} for more information.
   */
  protected onlyCaptureFinalAttempt = true;

  /**
   * See {@link SentryMiddlewareOptions} for more information.
   */
  protected captureStepErrors = false;

  // Isolation scope created in wrapRequest. Used for setting tags and
  // breadcrumbs scoped to this function run.
  #scope?: Sentry.Scope;

  // Tags set in wrapRequest (function-level) and enriched in
  // wrapFunctionHandler (event-level). Reused as span attributes.
  #tags: Record<string, string | undefined> = {};

  // Deterministic trace ID derived from the run ID, used to group all
  // requests in a function run under one Sentry trace.
  #traceId?: string;

  // Per-request span representing one HTTP request in the durable execution.
  // Step spans are children of this span.
  #requestSpan?: Span;

  // Using a map is overkill right now since we never execute more than one step
  // at a time. But just in case that changes, we'll use a map. Until that
  // changes, the map size will always be 0 or 1.
  #stepSpans = new Map<string, Span>();

  // Tracks whether onRunError or onStepError fired. Used in wrapRequest's
  // finally to set OK status only when no error occurred — necessary because
  // onRunComplete only fires on the final request of a run, not on
  // intermediate requests where a step completed successfully.
  #hasError = false;

  // Sets up Sentry isolation scope, shared tags, a deterministic trace
  // derived from the run ID, and a per-request span. All requests in the
  // same Inngest function run share one Sentry trace; each request appears
  // as a child span with step spans nested beneath it.
  //
  // wrapRequest always resolves (even when wrapFunctionHandler's next()
  // doesn't, e.g. fresh step discovered), so the finally cleanup (ending
  // spans, flushing) reliably runs inside the Sentry async context.
  override wrapRequest({
    next,
    fn,
    runId,
  }: Middleware.WrapRequestArgs): Promise<Middleware.Response> {
    // Non-execution requests (GET introspection, PUT registration) have no
    // function context — skip Sentry setup entirely.
    if (!fn) {
      return next();
    }

    this.#traceId = ulidToTraceId(runId);
    const sentryTrace = `${this.#traceId}-1000000000000000-1`;

    // startNewTrace breaks out of the auto-instrumented HTTP span so our
    // trace ID (derived from the run ID) takes effect. continueTrace then
    // sets the propagation context with our deterministic trace ID.
    return Sentry.startNewTrace(() => {
      return Sentry.continueTrace(
        { sentryTrace, baggage: undefined },
        async () => {
          return Sentry.withIsolationScope(async (scope) => {
            this.#scope = scope;

            this.#tags = {
              "inngest.client.id": this.client.id,
              "inngest.function.id": fn.id(this.client.id),
              "inngest.function.name": fn.name,
              "inngest.run.id": runId,
            };

            scope.setTags(this.#tags);
            scope.setTransactionName(`inngest:${fn.name}`);

            return Sentry.startSpanManual(
              {
                name: fn.name,
                op: "request",
                attributes: this.#tags,
              },
              async (span) => {
                this.#requestSpan = span;
                try {
                  return await next();
                } finally {
                  if (!this.#hasError) {
                    this.#requestSpan?.setStatus({ code: 1 });
                  }

                  // End any step spans that weren't closed by
                  // onStepComplete/onStepError (e.g. request interrupted
                  // mid-step).
                  for (const stepSpan of this.#stepSpans.values()) {
                    stepSpan.end();
                  }
                  this.#requestSpan?.end();

                  if (!this.disableAutomaticFlush) {
                    await Sentry.flush();
                  }
                }
              },
            );
          });
        },
      );
    });
  }

  // Enriches the already-created Sentry span/scope with event-specific
  // data available only in wrapFunctionHandler's ctx.
  override async wrapFunctionHandler({
    next,
    ctx,
  }: Middleware.WrapFunctionHandlerArgs): Promise<unknown> {
    const eventTags = {
      "inngest.event.id": ctx.event.id,
      "inngest.event.name": ctx.event.name,
    };

    Object.assign(this.#tags, eventTags);
    this.#scope?.setTags(eventTags);
    this.#requestSpan?.setAttributes({
      ...eventTags,
      "inngest.event": JSON.stringify(ctx.event),
    });

    return await next();
  }

  // Injects ctx.sentry so user code can access the Sentry client directly.
  //
  // The explicit return type enables TypeScript to infer ctx.sentry in
  // function handlers when this middleware is registered on the client.
  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs & {
    ctx: { sentry: typeof Sentry };
  } {
    return { ...arg, ctx: { ...arg.ctx, sentry: Sentry } };
  }

  // Captures function-level errors using the stored isolation scope.
  override onRunError({ error, isFinalAttempt }: Middleware.OnRunErrorArgs) {
    this.#hasError = true;
    this.#requestSpan?.setStatus({ code: 2 });

    if (!this.onlyCaptureFinalAttempt || isFinalAttempt) {
      this.#captureException(error, {
        // Used to distinguish run-level errors from step-level errors.
        "inngest.error.source": "run",
      });
    }
  }

  // The `onStep*` hooks only fire for step types that execute locally (`run`,
  // `sendEvent`). Other step types (`sleep`, `waitForEvent`, etc.) are returned
  // to the server as instructions with no local execution.
  //
  // With checkpointing, multiple steps can execute within a single request, so
  // these fire per step.
  override onStepStart({ stepInfo }: Middleware.OnStepStartArgs) {
    const span = Sentry.startInactiveSpan({
      name: stepDisplayName(stepInfo.options),
      op: "step",
      parentSpan: this.#requestSpan,
      attributes: {
        ...this.#tags,
        "inngest.step.name": stepDisplayName(stepInfo.options),
        "inngest.step.type": String(stepInfo.stepType),
      },
    });
    this.#stepSpans.set(stepInfo.hashedId, span);
  }

  override onStepComplete({ stepInfo }: Middleware.OnStepCompleteArgs) {
    const span = this.#stepSpans.get(stepInfo.hashedId);
    if (span) {
      span.setStatus({ code: 1 });
      span.end();
      this.#stepSpans.delete(stepInfo.hashedId);
    }

    this.#scope?.addBreadcrumb({
      category: "inngest.step",
      message: stepDisplayName(stepInfo.options),
      data: { type: String(stepInfo.stepType) },
      level: "info",
    });
  }

  override onStepError({
    error,
    isFinalAttempt,
    stepInfo,
  }: Middleware.OnStepErrorArgs) {
    this.#hasError = true;
    this.#requestSpan?.setStatus({ code: 2 });

    const span = this.#stepSpans.get(stepInfo.hashedId);
    if (span) {
      span.setStatus({ code: 2 });
      span.end();
      this.#stepSpans.delete(stepInfo.hashedId);
    }

    this.#scope?.addBreadcrumb({
      category: "inngest.step",
      message: stepDisplayName(stepInfo.options),
      data: { type: String(stepInfo.stepType) },
      level: "error",
    });

    if (
      this.captureStepErrors &&
      (!this.onlyCaptureFinalAttempt || isFinalAttempt)
    ) {
      // Pass the step span so the error appears under it in the trace view.
      // spanContext() is valid even after end().
      this.#captureException(
        error,
        {
          "inngest.error.source": "step",
          "inngest.step.name": stepDisplayName(stepInfo.options),
        },
        span,
      );
    }
  }

  // Captures an exception under the given span (or the request span by
  // default). withActiveSpan sets the span as active so the error event's
  // trace.span_id matches, linking the error to that span in the trace view.
  #captureException(error: unknown, tags: Record<string, string>, span?: Span) {
    if (this.#scope) {
      this.#scope.setTags(tags);
    }

    const allTags = { ...this.#tags, ...tags };
    const targetSpan = span ?? this.#requestSpan;

    if (targetSpan) {
      Sentry.withActiveSpan(targetSpan, () => {
        Sentry.captureException(error, { tags: allTags });
      });
    } else {
      Sentry.captureException(error, { tags: allTags });
    }
  }
}

/**
 * Creates a configured Sentry middleware class.
 *
 * For default behavior, you can pass {@link SentryMiddleware} directly instead.
 */
export const sentryMiddleware = (opts?: SentryMiddlewareOptions) => {
  const {
    captureStepErrors = false,
    disableAutomaticFlush = false,
    onlyCaptureFinalAttempt = true,
  } = opts ?? {};

  // Return the base class directly when all options match defaults.
  if (!captureStepErrors && !disableAutomaticFlush && onlyCaptureFinalAttempt) {
    return SentryMiddleware;
  }

  return class extends SentryMiddleware {
    protected override captureStepErrors = captureStepErrors;
    protected override disableAutomaticFlush = disableAutomaticFlush;
    protected override onlyCaptureFinalAttempt = onlyCaptureFinalAttempt;
  };
};

function stepDisplayName(stepOptions: { name?: string; id: string }): string {
  return stepOptions.name ?? stepOptions.id;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Converts a ULID (128-bit, Crockford base32) to a 32-char hex string suitable
 * for use as a Sentry trace ID. This is a lossless 1:1 mapping.
 */
function ulidToTraceId(ulid: string): string {
  const upper = ulid.toUpperCase();
  const bytes = new Uint8Array(16);

  // 26 Crockford base32 chars = 130 bits, but only 128 are meaningful.
  // First char contributes 3 bits (discard the top 2 of the 5-bit value).
  let bitBuf = CROCKFORD.indexOf(upper[0]) & 0x07;
  let bitCount = 3;
  let byteIdx = 0;

  for (let i = 1; i < upper.length; i++) {
    bitBuf = (bitBuf << 5) | CROCKFORD.indexOf(upper[i]);
    bitCount += 5;

    while (bitCount >= 8 && byteIdx < 16) {
      bitCount -= 8;
      bytes[byteIdx++] = (bitBuf >>> bitCount) & 0xff;
      bitBuf &= (1 << bitCount) - 1;
    }
  }

  let hex = "";
  for (let i = 0; i < 16; i++) {
    const h = bytes[i].toString(16);
    hex += h.length < 2 ? "0" + h : h;
  }
  return hex;
}
