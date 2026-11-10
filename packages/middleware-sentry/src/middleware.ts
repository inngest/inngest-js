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

  /**
   * If `true`, propagates active Sentry trace data (`sentry-trace` and
   * `baggage`) onto outgoing events sent via `inngest.send()`,
   * `step.sendEvent()`, or `step.invoke()`, and continues the sender's trace
   * when executing triggered function runs.
   *
   * When `false` (or when no sender trace is present), each function run starts
   * an isolated trace derived deterministically from its `runId`.
   *
   * @default true
   */
  continueSenderTrace?: boolean;
}

/**
 * Internal event data field used to propagate Sentry trace headers across
 * asynchronous event dispatch.
 */
export const SENTRY_TRACE_DATA_KEY = "__inngest_sentry_trace";

interface PropagatedSentryTrace {
  sentryTrace: string;
  baggage?: string;
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

  /**
   * See {@link SentryMiddlewareOptions} for more information.
   */
  protected continueSenderTrace = true;

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
  override async wrapRequest({
    next,
    fn,
    runId,
    requestInfo,
  }: Middleware.WrapRequestArgs): Promise<Middleware.Response> {
    // Non-execution requests (GET introspection, PUT registration) have no
    // function context — skip Sentry setup entirely.
    if (!fn) {
      return next();
    }

    const propagated = this.continueSenderTrace
      ? await extractIncomingTrace(requestInfo)
      : undefined;

    const fallbackTraceId = ulidToTraceId(runId);
    this.#traceId = propagated
      ? (extractTraceIdFromSentryTrace(propagated.sentryTrace) ??
        fallbackTraceId)
      : fallbackTraceId;

    const sentryTrace =
      propagated?.sentryTrace ?? `${this.#traceId}-1000000000000000-1`;
    const baggage = propagated?.baggage;

    // startNewTrace breaks out of the auto-instrumented HTTP span so our
    // trace ID (from the sender or derived from the run ID) takes effect.
    // continueTrace then sets the propagation context on the scope.
    return Sentry.startNewTrace(() => {
      return Sentry.continueTrace({ sentryTrace, baggage }, async () => {
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
      });
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

  // Injects ctx.sentry so user code can access the Sentry client directly,
  // and strips internal trace propagation metadata from event.data.
  //
  // The explicit return type enables TypeScript to infer ctx.sentry in
  // function handlers when this middleware is registered on the client.
  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs & {
    ctx: { sentry: typeof Sentry };
  } {
    const cleanedEvent = stripPropagatedTraceFromEvent(arg.ctx.event);
    const cleanedEvents = Array.isArray(arg.ctx.events)
      ? (arg.ctx.events.map((evt) =>
          stripPropagatedTraceFromEvent(evt),
        ) as typeof arg.ctx.events)
      : arg.ctx.events;

    return {
      ...arg,
      ctx: {
        ...arg.ctx,
        event: cleanedEvent,
        events: cleanedEvents,
        sentry: Sentry,
      },
    };
  }

  override transformSendEvent(
    arg: Middleware.TransformSendEventArgs,
  ): Middleware.TransformSendEventArgs {
    if (!this.continueSenderTrace) {
      return arg;
    }

    const traceData = getActiveSenderTraceData();
    if (!traceData) {
      return arg;
    }

    return {
      ...arg,
      events: arg.events.map((event) =>
        attachPropagatedTraceToEvent(event, traceData),
      ),
    };
  }

  override transformStepInput(
    arg: Middleware.TransformStepInputArgs,
  ): Middleware.TransformStepInputArgs {
    if (!this.continueSenderTrace || arg.stepInfo.stepType !== "invoke") {
      return arg;
    }

    const traceData = getActiveSenderTraceData();
    if (!traceData) {
      return arg;
    }

    return {
      ...arg,
      input: arg.input.map((item) => {
        if (!isRecord(item) || !isRecord(item.payload)) {
          return item;
        }
        return {
          ...item,
          payload: attachPropagatedTraceToEvent(item.payload, traceData),
        };
      }),
    };
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
    continueSenderTrace = true,
    disableAutomaticFlush = false,
    onlyCaptureFinalAttempt = true,
  } = opts ?? {};

  // Return the base class directly when all options match defaults.
  if (
    !captureStepErrors &&
    continueSenderTrace &&
    !disableAutomaticFlush &&
    onlyCaptureFinalAttempt
  ) {
    return SentryMiddleware;
  }

  return class extends SentryMiddleware {
    protected override captureStepErrors = captureStepErrors;
    protected override continueSenderTrace = continueSenderTrace;
    protected override disableAutomaticFlush = disableAutomaticFlush;
    protected override onlyCaptureFinalAttempt = onlyCaptureFinalAttempt;
  };
};

function stepDisplayName(stepOptions: { name?: string; id: string }): string {
  return stepOptions.name ?? stepOptions.id;
}

const SENTRY_TRACE_HEADER_RE = /^([0-9a-f]{32})-[0-9a-f]{16}(?:-[01])?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTraceIdFromSentryTrace(
  sentryTrace: string,
): string | undefined {
  const match = SENTRY_TRACE_HEADER_RE.exec(sentryTrace.trim());
  return match?.[1]?.toLowerCase();
}

function getActiveSenderTraceData(): PropagatedSentryTrace | undefined {
  const activeSpan = Sentry.getActiveSpan();
  if (activeSpan) {
    const sentryTrace = Sentry.spanToTraceHeader(activeSpan);
    const baggage = Sentry.spanToBaggageHeader(activeSpan);
    return {
      sentryTrace,
      ...(baggage ? { baggage } : {}),
    };
  }

  const propagationContext = {
    ...Sentry.getIsolationScope().getPropagationContext(),
    ...Sentry.getCurrentScope().getPropagationContext(),
  };

  if (!propagationContext.parentSpanId && !propagationContext.dsc) {
    return undefined;
  }

  const sampledSuffix =
    typeof propagationContext.sampled === "boolean"
      ? `-${propagationContext.sampled ? "1" : "0"}`
      : "";
  const sentryTrace = `${propagationContext.traceId}-${propagationContext.spanId}${sampledSuffix}`;

  let baggage: string | undefined;
  if (isRecord(propagationContext.dsc)) {
    const entries = Object.entries(propagationContext.dsc).filter(
      ([, v]) => typeof v === "string" && v.length > 0,
    );
    if (entries.length > 0) {
      baggage = entries
        .map(([k, v]) => `sentry-${k}=${encodeURIComponent(String(v))}`)
        .join(",");
    }
  }

  return {
    sentryTrace,
    ...(baggage ? { baggage } : {}),
  };
}

function attachPropagatedTraceToEvent<T extends { data?: unknown }>(
  event: T,
  traceData: PropagatedSentryTrace,
): T {
  if (event.data !== undefined && !isRecord(event.data)) {
    return event;
  }

  const existingData = isRecord(event.data) ? event.data : {};
  if (SENTRY_TRACE_DATA_KEY in existingData) {
    return event;
  }

  return {
    ...event,
    data: {
      ...existingData,
      [SENTRY_TRACE_DATA_KEY]: traceData,
    },
  };
}

function stripPropagatedTraceFromEvent<T>(event: T): T {
  if (!isRecord(event) || !isRecord(event.data)) {
    return event;
  }

  if (!(SENTRY_TRACE_DATA_KEY in event.data)) {
    return event;
  }

  const { [SENTRY_TRACE_DATA_KEY]: _removed, ...restData } = event.data;
  return {
    ...event,
    data: restData,
  };
}

function parsePropagatedTraceCandidate(
  candidate: unknown,
): PropagatedSentryTrace | undefined {
  if (!isRecord(candidate)) {
    return undefined;
  }

  const sentryTrace = candidate.sentryTrace;
  if (
    typeof sentryTrace !== "string" ||
    !extractTraceIdFromSentryTrace(sentryTrace)
  ) {
    return undefined;
  }

  const baggage =
    typeof candidate.baggage === "string" && candidate.baggage.length > 0
      ? candidate.baggage
      : undefined;

  return {
    sentryTrace: sentryTrace.trim(),
    ...(baggage ? { baggage } : {}),
  };
}

function extractTraceFromEventObject(
  eventObj: unknown,
): PropagatedSentryTrace | undefined {
  if (!isRecord(eventObj) || !isRecord(eventObj.data)) {
    return undefined;
  }

  const fromCarrier = parsePropagatedTraceCandidate(
    eventObj.data[SENTRY_TRACE_DATA_KEY],
  );
  if (fromCarrier) {
    return fromCarrier;
  }

  const directTrace = eventObj.data["sentry-trace"];
  if (
    typeof directTrace === "string" &&
    extractTraceIdFromSentryTrace(directTrace)
  ) {
    const directBaggage =
      typeof eventObj.data.baggage === "string" &&
      eventObj.data.baggage.length > 0
        ? eventObj.data.baggage
        : undefined;
    return {
      sentryTrace: directTrace.trim(),
      ...(directBaggage ? { baggage: directBaggage } : {}),
    };
  }

  return undefined;
}

async function extractIncomingTrace(
  requestInfo: Middleware.WrapRequestArgs["requestInfo"] | undefined,
): Promise<PropagatedSentryTrace | undefined> {
  if (!requestInfo) {
    return undefined;
  }

  if (isRecord(requestInfo.headers)) {
    let headerSentryTrace: string | undefined;
    let headerBaggage: string | undefined;
    for (const [key, value] of Object.entries(requestInfo.headers)) {
      if (typeof value !== "string") continue;
      const lower = key.toLowerCase();
      if (lower === "sentry-trace") {
        headerSentryTrace = value;
      } else if (lower === "baggage") {
        headerBaggage = value;
      }
    }

    if (headerSentryTrace && extractTraceIdFromSentryTrace(headerSentryTrace)) {
      return {
        sentryTrace: headerSentryTrace.trim(),
        ...(headerBaggage ? { baggage: headerBaggage } : {}),
      };
    }
  }

  try {
    const rawBody = await requestInfo.body?.();
    const parsedBody =
      typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    if (!isRecord(parsedBody)) {
      return undefined;
    }

    const fromPrimaryEvent = extractTraceFromEventObject(parsedBody.event);
    if (fromPrimaryEvent) {
      return fromPrimaryEvent;
    }

    if (Array.isArray(parsedBody.events)) {
      for (const evt of parsedBody.events) {
        const fromBatchEvent = extractTraceFromEventObject(evt);
        if (fromBatchEvent) {
          return fromBatchEvent;
        }
      }
    }
  } catch {
    // Ignore body read or JSON parse errors and fall back to runId-derived trace.
  }

  return undefined;
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
