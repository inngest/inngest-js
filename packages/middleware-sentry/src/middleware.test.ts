import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Sentry before importing the middleware.
const mockScope = {
  setTags: vi.fn(),
  setTransactionName: vi.fn(),
  addBreadcrumb: vi.fn(),
};

const mockSpan = {
  setStatus: vi.fn(),
  setAttributes: vi.fn(),
  end: vi.fn(),
  spanContext: vi.fn(() => ({
    traceId: "00000000000000000000000000000000",
    spanId: "0000000000000000",
  })),
};

// Remote parent span returned by getActiveSpan inside continueTrace.
const mockRemoteParentSpan = {
  spanContext: vi.fn(() => ({
    traceId: "00000000000000000000000000000000",
    spanId: "1000000000000000",
    isRemote: true,
  })),
};

vi.mock("@sentry/core", () => ({
  withIsolationScope: vi.fn((cb: (scope: typeof mockScope) => unknown) =>
    cb(mockScope),
  ),
  startSpanManual: vi.fn(
    (_opts: unknown, cb: (span: typeof mockSpan) => unknown) => cb(mockSpan),
  ),
  startInactiveSpan: vi.fn(() => ({ ...mockSpan })),
  startNewTrace: vi.fn((cb: () => unknown) => cb()),
  continueTrace: vi.fn((_opts: unknown, cb: () => unknown) => cb()),
  withActiveSpan: vi.fn((_span: unknown, cb: () => unknown) => cb()),
  getActiveSpan: vi.fn(() => mockRemoteParentSpan),
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
}));

import * as Sentry from "@sentry/core";
import { SentryMiddleware, sentryMiddleware } from "./middleware";

// Minimal mock to satisfy BaseMiddleware's constructor.
const mockClient = { id: "test-app" } as ConstructorParameters<
  typeof SentryMiddleware
>[0]["client"];

// Reusable fixtures.
const mockCtx = {
  event: { id: "evt-1", name: "test/event" },
  runId: "run-1",
} as Parameters<
  typeof SentryMiddleware.prototype.wrapFunctionHandler
>[0]["ctx"];

const mockFn = {
  id: (clientId: string) => `${clientId}-fn-1`,
  name: "My Function",
} as Parameters<typeof SentryMiddleware.prototype.wrapFunctionHandler>[0]["fn"];

function makeStepInfo(overrides?: Record<string, unknown>) {
  return {
    hashedId: "abc123",
    memoized: false,
    options: { id: "fetch-user", name: undefined },
    stepType: "run",
    ...overrides,
  } as Parameters<typeof SentryMiddleware.prototype.onStepStart>[0]["stepInfo"];
}

// Drives the middleware through the wrapRequest → wrapFunctionHandler → next()
// lifecycle. The `run` callback receives the middleware instance so tests can
// call hooks (onStepStart, onRunError, etc.) between wrapFunctionHandler and
// the end of wrapRequest.
async function runMiddleware(
  mw: SentryMiddleware,
  run: (mw: SentryMiddleware) => void | Promise<void>,
) {
  await mw.wrapRequest({
    fn: mockFn,
    runId: "run-1",
    next: async () => {
      await mw.wrapFunctionHandler({
        next: async () => {
          await run(mw);
        },
        ctx: mockCtx,
        fn: mockFn,
      } as Parameters<
        typeof SentryMiddleware.prototype.wrapFunctionHandler
      >[0]);
      return { status: 200, body: "", headers: {} };
    },
  } as Parameters<typeof SentryMiddleware.prototype.wrapRequest>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("non-execution request", () => {
  it("skips Sentry setup when fn is null", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await mw.wrapRequest({
      fn: null,
      runId: "",
      next: async () => ({ status: 200, body: "", headers: {} }),
    } as Parameters<typeof SentryMiddleware.prototype.wrapRequest>[0]);

    expect(Sentry.startNewTrace).not.toHaveBeenCalled();
    expect(Sentry.startSpanManual).not.toHaveBeenCalled();
    expect(Sentry.flush).not.toHaveBeenCalled();
  });
});

describe("happy path", () => {
  it("ends request span with OK and flushes", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await runMiddleware(mw, () => {});

    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(mockSpan.end).toHaveBeenCalled();
    expect(Sentry.flush).toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("creates request span with function name and op 'request'", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await runMiddleware(mw, () => {});

    expect(Sentry.startSpanManual).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My Function", op: "request" }),
      expect.any(Function),
    );
  });
});

describe("abandoned execution", () => {
  it("cleans up spans and flushes when wrapFunctionHandler never resolves", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await mw.wrapRequest({
      fn: mockFn,
      runId: "run-1",
      next: async () => {
        // Simulate fresh step discovery: wrapFunctionHandler's next() never
        // resolves, but wrapRequest's next() still returns a response.
        mw.wrapFunctionHandler({
          next: () => new Promise(() => {}),
          ctx: mockCtx,
          fn: mockFn,
        } as Parameters<
          typeof SentryMiddleware.prototype.wrapFunctionHandler
        >[0]);

        mw.onStepStart({
          stepInfo: makeStepInfo(),
        } as Parameters<typeof mw.onStepStart>[0]);

        return { status: 200, body: "", headers: {} };
      },
    } as Parameters<typeof SentryMiddleware.prototype.wrapRequest>[0]);

    // Orphaned step span ended in finally.
    const stepSpan = Sentry.startInactiveSpan({} as never);
    expect(stepSpan.end).toHaveBeenCalled();

    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(mockSpan.end).toHaveBeenCalled();
    expect(Sentry.flush).toHaveBeenCalled();
  });
});

describe("function error", () => {
  it("captures exception and sets error status on request span", async () => {
    const mw = new SentryMiddleware({ client: mockClient });
    const error = new Error("boom");

    await runMiddleware(mw, () => {
      mw.onRunError({
        error,
        isFinalAttempt: true,
      } as Parameters<typeof mw.onRunError>[0]);
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: expect.objectContaining({ "inngest.error.source": "run" }),
    });
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2 });
  });
});

describe("step lifecycle", () => {
  it("creates and ends step span on success", async () => {
    const mw = new SentryMiddleware({ client: mockClient });
    const stepSpan = Sentry.startInactiveSpan({} as never);

    await runMiddleware(mw, () => {
      mw.onStepStart({
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepStart>[0]);

      mw.onStepComplete({
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepComplete>[0]);
    });

    expect(stepSpan.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(stepSpan.end).toHaveBeenCalled();
  });

  it("uses step id as span name when display name is not set", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await runMiddleware(mw, () => {
      mw.onStepStart({
        stepInfo: makeStepInfo({ options: { id: "my-step" } }),
      } as Parameters<typeof mw.onStepStart>[0]);
    });

    expect(Sentry.startInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my-step" }),
    );
  });

  it("prefers display name over id", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await runMiddleware(mw, () => {
      mw.onStepStart({
        stepInfo: makeStepInfo({
          options: { id: "my-step", name: "My Step" },
        }),
      } as Parameters<typeof mw.onStepStart>[0]);
    });

    expect(Sentry.startInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My Step" }),
    );
  });

  it("parents step spans under the request span", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await runMiddleware(mw, () => {
      mw.onStepStart({
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepStart>[0]);
    });

    expect(Sentry.startInactiveSpan).toHaveBeenCalledWith(
      expect.objectContaining({ parentSpan: mockSpan }),
    );
  });

  it("adds breadcrumb on step error", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await runMiddleware(mw, () => {
      mw.onStepStart({
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepStart>[0]);

      mw.onStepError({
        error: new Error("step fail"),
        isFinalAttempt: true,
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepError>[0]);
    });

    expect(mockScope.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "inngest.step",
        message: "fetch-user",
        level: "error",
      }),
    );
  });
});

describe("captureStepErrors", () => {
  it("does not capture step errors by default", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await runMiddleware(mw, () => {
      mw.onStepStart({
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepStart>[0]);

      mw.onStepError({
        error: new Error("step fail"),
        isFinalAttempt: true,
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepError>[0]);
    });

    // Span still gets error status.
    const stepSpan = Sentry.startInactiveSpan({} as never);
    expect(stepSpan.setStatus).toHaveBeenCalledWith({ code: 2 });

    // But no Sentry event.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures step errors when enabled", async () => {
    const Cls = sentryMiddleware({ captureStepErrors: true });
    const mw = new Cls({ client: mockClient });
    const error = new Error("step fail");

    await runMiddleware(mw, () => {
      mw.onStepStart({
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepStart>[0]);

      mw.onStepError({
        error,
        isFinalAttempt: true,
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepError>[0]);
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: expect.objectContaining({
        "inngest.error.source": "step",
        "inngest.step.name": "fetch-user",
      }),
    });
  });

  it("parents step error to the step span, not the request span", async () => {
    const customStepSpan = {
      ...mockSpan,
      spanContext: vi.fn(() => ({
        traceId: "00000000000000000000000000000000",
        spanId: "aabbccddee112233",
      })),
    };
    vi.mocked(Sentry.startInactiveSpan).mockReturnValueOnce(
      customStepSpan as unknown as ReturnType<typeof Sentry.startInactiveSpan>,
    );

    const Cls = sentryMiddleware({ captureStepErrors: true });
    const mw = new Cls({ client: mockClient });

    await runMiddleware(mw, () => {
      mw.onStepStart({
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepStart>[0]);

      mw.onStepError({
        error: new Error("step fail"),
        isFinalAttempt: true,
        stepInfo: makeStepInfo(),
      } as Parameters<typeof mw.onStepError>[0]);
    });

    // withActiveSpan should receive the step span, not the request span.
    expect(Sentry.withActiveSpan).toHaveBeenCalledWith(
      customStepSpan,
      expect.any(Function),
    );
  });
});

describe("onlyCaptureFinalAttempt", () => {
  it("skips capture on non-final attempt (default)", async () => {
    const mw = new SentryMiddleware({ client: mockClient });

    await runMiddleware(mw, () => {
      mw.onRunError({
        error: new Error("transient"),
        isFinalAttempt: false,
      } as Parameters<typeof mw.onRunError>[0]);
    });

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures on non-final attempt when disabled", async () => {
    const Cls = sentryMiddleware({ onlyCaptureFinalAttempt: false });
    const mw = new Cls({ client: mockClient });
    const error = new Error("transient");

    await runMiddleware(mw, () => {
      mw.onRunError({
        error,
        isFinalAttempt: false,
      } as Parameters<typeof mw.onRunError>[0]);
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: expect.objectContaining({ "inngest.error.source": "run" }),
    });
  });
});

describe("disableAutomaticFlush", () => {
  it("does not flush when disabled", async () => {
    const Cls = sentryMiddleware({ disableAutomaticFlush: true });
    const mw = new Cls({ client: mockClient });

    await runMiddleware(mw, () => {});

    expect(Sentry.flush).not.toHaveBeenCalled();
  });
});

describe("transformFunctionInput", () => {
  it("injects ctx.sentry", () => {
    const mw = new SentryMiddleware({ client: mockClient });

    const result = mw.transformFunctionInput({
      ctx: {},
      steps: {},
    } as Parameters<typeof mw.transformFunctionInput>[0]);

    expect(result.ctx.sentry).toBe(Sentry);
  });
});

describe("sentryMiddleware", () => {
  it("returns SentryMiddleware when called with no args", () => {
    expect(sentryMiddleware()).toBe(SentryMiddleware);
  });

  it("returns SentryMiddleware when called with empty object", () => {
    expect(sentryMiddleware({})).toBe(SentryMiddleware);
  });

  it("returns subclass when options differ from defaults", () => {
    const Cls = sentryMiddleware({ disableAutomaticFlush: true });
    expect(Cls).not.toBe(SentryMiddleware);
    expect(new Cls({ client: mockClient })).toBeInstanceOf(SentryMiddleware);
  });
});
