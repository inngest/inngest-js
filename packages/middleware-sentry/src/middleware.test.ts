import * as Sentry from "@sentry/core";
import { describe, expect, test } from "vitest";
import {
  SENTRY_TRACE_DATA_KEY,
  SentryMiddleware,
  sentryMiddleware,
} from "./middleware";
import {
  capturedTransactions,
  initSentryCapture,
} from "./test/integration/helpers";

const mockClient = { id: "test-app" } as never;
const mockFn = {
  id: (prefix?: string) => (prefix ? `${prefix}-fn` : "fn"),
  name: "Test Function",
} as never;

describe("SentryMiddleware sender trace continuation", () => {
  test("transformSendEvent attaches active span trace data to outgoing events", () => {
    initSentryCapture();
    const mw = new SentryMiddleware({ client: mockClient });

    let expectedTraceId = "";
    let expectedSpanId = "";
    let transformed: ReturnType<typeof mw.transformSendEvent> | undefined;

    Sentry.startSpan({ name: "POST /checkout", op: "http.server" }, (span) => {
      const ctx = span.spanContext();
      expectedTraceId = ctx.traceId;
      expectedSpanId = ctx.spanId;

      transformed = mw.transformSendEvent({
        events: [
          {
            name: "order/created",
            data: { orderId: "ord_123" },
          },
        ],
        fn: null,
      });
    });

    const eventData = transformed?.events[0]?.data as Record<string, unknown>;
    expect(eventData.orderId).toBe("ord_123");

    const carrier = eventData[SENTRY_TRACE_DATA_KEY] as {
      sentryTrace: string;
      baggage?: string;
    };
    expect(carrier).toBeDefined();
    expect(carrier.sentryTrace).toBe(`${expectedTraceId}-${expectedSpanId}-1`);
    expect(carrier.baggage).toContain(`sentry-trace_id=${expectedTraceId}`);
  });

  test("transformSendEvent attaches trace data from Sentry.continueTrace when no span is active", () => {
    initSentryCapture();
    const mw = new SentryMiddleware({ client: mockClient });

    const upstreamTraceId = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const upstreamSpanId = "1122334455667788";

    const transformed = Sentry.continueTrace(
      {
        sentryTrace: `${upstreamTraceId}-${upstreamSpanId}-1`,
        baggage: `sentry-trace_id=${upstreamTraceId},sentry-sampled=true`,
      },
      () =>
        mw.transformSendEvent({
          events: [{ name: "order/created", data: { orderId: "ord_456" } }],
          fn: null,
        }),
    );

    const eventData = transformed.events[0]?.data as Record<string, unknown>;
    const carrier = eventData[SENTRY_TRACE_DATA_KEY] as {
      sentryTrace: string;
      baggage?: string;
    };
    expect(carrier).toBeDefined();
    expect(carrier.sentryTrace).toMatch(
      new RegExp(`^${upstreamTraceId}-[0-9a-f]{16}-1$`),
    );
    expect(carrier.baggage).toContain(`sentry-trace_id=${upstreamTraceId}`);
  });

  test("transformSendEvent does not attach trace data when no sender trace is active", () => {
    initSentryCapture();
    const mw = new SentryMiddleware({ client: mockClient });

    const original = {
      events: [{ name: "order/created", data: { orderId: "ord_789" } }],
      fn: null,
    };

    const transformed = mw.transformSendEvent(original);
    expect(transformed.events[0]?.data).toEqual({ orderId: "ord_789" });
    expect(
      (transformed.events[0]?.data as Record<string, unknown>)[
        SENTRY_TRACE_DATA_KEY
      ],
    ).toBeUndefined();
  });

  test("transformSendEvent skips trace propagation when continueSenderTrace is false", () => {
    initSentryCapture();
    const Cls = sentryMiddleware({ continueSenderTrace: false });
    const mw = new Cls({ client: mockClient });

    const transformed = Sentry.startSpan({ name: "POST /checkout" }, () =>
      mw.transformSendEvent({
        events: [{ name: "order/created", data: { orderId: "ord_000" } }],
        fn: null,
      }),
    );

    expect(transformed.events[0]?.data).toEqual({ orderId: "ord_000" });
  });

  test("transformStepInput propagates active trace onto step.invoke payloads", () => {
    initSentryCapture();
    const mw = new SentryMiddleware({ client: mockClient });

    let expectedTraceId = "";
    const transformed = Sentry.startSpan({ name: "parent-fn" }, (span) => {
      expectedTraceId = span.spanContext().traceId;
      return mw.transformStepInput({
        fn: mockFn,
        stepInfo: { hashedId: "h1", memoized: false, stepType: "invoke" },
        stepOptions: { id: "invoke-child" },
        input: [{ payload: { data: { userId: "u_1" } } }],
      });
    });

    const item = transformed.input[0] as {
      payload: { data: Record<string, unknown> };
    };
    expect(item.payload.data.userId).toBe("u_1");
    const carrier = item.payload.data[SENTRY_TRACE_DATA_KEY] as {
      sentryTrace: string;
    };
    expect(carrier?.sentryTrace).toContain(expectedTraceId);
  });

  test("transformFunctionInput strips internal trace carrier from ctx.event and ctx.events", () => {
    const mw = new SentryMiddleware({ client: mockClient });
    const rawEvent = {
      name: "order/created",
      data: {
        orderId: "ord_123",
        [SENTRY_TRACE_DATA_KEY]: {
          sentryTrace: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4-1122334455667788-1",
        },
      },
    };

    const result = mw.transformFunctionInput({
      ctx: {
        event: rawEvent,
        events: [rawEvent],
      } as never,
      fn: mockFn,
      steps: {},
    });

    expect(result.ctx.event.data).toEqual({ orderId: "ord_123" });
    expect(result.ctx.events[0]?.data).toEqual({ orderId: "ord_123" });
    expect(result.ctx.sentry).toBe(Sentry);
  });

  test("wrapRequest continues sender trace from event payload across multi-step requests", async () => {
    const captured = initSentryCapture();
    const senderMw = new SentryMiddleware({ client: mockClient });

    let senderTraceId = "";
    let senderSpanId = "";
    let sentEvent: unknown;

    Sentry.startSpan({ name: "POST /checkout", op: "http.server" }, (span) => {
      senderTraceId = span.spanContext().traceId;
      senderSpanId = span.spanContext().spanId;
      const transformed = senderMw.transformSendEvent({
        events: [{ name: "order/created", data: { orderId: "ord_123" } }],
        fn: null,
      });
      sentEvent = transformed.events[0];
    });

    await Sentry.flush();

    const runId = "01J00000000000000000000001";
    for (const stepNum of [1, 2]) {
      const requestMw = new SentryMiddleware({ client: mockClient });
      await requestMw.wrapRequest({
        fn: mockFn,
        runId,
        requestArgs: [],
        requestInfo: {
          headers: {},
          method: "POST",
          url: new URL("http://localhost:3000/api/inngest"),
          body: async () => ({
            event: sentEvent,
            events: [sentEvent],
            ctx: { run_id: runId },
          }),
        },
        next: async () => {
          const stepId = `step-${stepNum}`;
          requestMw.onStepStart({
            ctx: {} as never,
            fn: mockFn,
            stepInfo: {
              hashedId: stepId,
              memoized: false,
              stepType: "run",
              options: { id: stepId },
            } as never,
          });
          requestMw.onStepComplete({
            ctx: {} as never,
            fn: mockFn,
            output: "ok",
            stepInfo: {
              hashedId: stepId,
              memoized: false,
              stepType: "run",
              options: { id: stepId },
            } as never,
          });
          return { status: 200, headers: {}, body: "{}" };
        },
      });
    }

    const txs = capturedTransactions(captured);
    const fnTxs = txs.filter(
      (tx) => tx.payload.transaction === "Test Function",
    );
    expect(fnTxs).toHaveLength(2);

    for (const tx of fnTxs) {
      const traceCtx = (
        tx.payload.contexts as Record<string, Record<string, unknown>>
      )?.trace;
      expect(traceCtx?.trace_id).toBe(senderTraceId);
      expect(traceCtx?.parent_span_id).toBe(senderSpanId);
    }
  });

  test("wrapRequest continues sender trace from incoming sentry-trace request header", async () => {
    const captured = initSentryCapture();
    const mw = new SentryMiddleware({ client: mockClient });

    const headerTraceId = "f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3";
    const headerSpanId = "abcdef0123456789";

    await mw.wrapRequest({
      fn: mockFn,
      runId: "01J00000000000000000000002",
      requestArgs: [],
      requestInfo: {
        headers: {
          "sentry-trace": `${headerTraceId}-${headerSpanId}-1`,
          baggage: `sentry-trace_id=${headerTraceId},sentry-sampled=true`,
        },
        method: "POST",
        url: new URL("http://localhost:3000/api/inngest"),
        body: async () => ({}),
      },
      next: async () => ({ status: 200, headers: {}, body: "{}" }),
    });

    const txs = capturedTransactions(captured);
    expect(txs).toHaveLength(1);
    const traceCtx = (
      txs[0]?.payload.contexts as Record<string, Record<string, unknown>>
    )?.trace;
    expect(traceCtx?.trace_id).toBe(headerTraceId);
    expect(traceCtx?.parent_span_id).toBe(headerSpanId);
  });

  test("wrapRequest uses runId-derived trace when continueSenderTrace is false", async () => {
    const captured = initSentryCapture();
    const Cls = sentryMiddleware({ continueSenderTrace: false });
    const mw = new Cls({ client: mockClient });

    const headerTraceId = "f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3";
    const headerSpanId = "abcdef0123456789";

    await mw.wrapRequest({
      fn: mockFn,
      runId: "01J00000000000000000000003",
      requestArgs: [],
      requestInfo: {
        headers: {
          "sentry-trace": `${headerTraceId}-${headerSpanId}-1`,
        },
        method: "POST",
        url: new URL("http://localhost:3000/api/inngest"),
        body: async () => ({}),
      },
      next: async () => ({ status: 200, headers: {}, body: "{}" }),
    });

    const txs = capturedTransactions(captured);
    expect(txs).toHaveLength(1);
    const traceCtx = (
      txs[0]?.payload.contexts as Record<string, Record<string, unknown>>
    )?.trace;
    expect(traceCtx?.trace_id).not.toBe(headerTraceId);
    expect(traceCtx?.parent_span_id).toBe("1000000000000000");
  });
});
