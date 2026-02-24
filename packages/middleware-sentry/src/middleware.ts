import * as Sentry from "@sentry/core";
import type { Span } from "@sentry/types";
import { Middleware } from "inngest";

/**
 * Options used to configure the Sentry middleware.
 */
export interface SentryMiddlewareOptions {
  /**
   * If `true`, the Sentry middleware will not automatically flush events after
   * each function run. This can be useful if you want to control when events
   * are sent to Sentry, or leave it to Sentry's default behavior.
   *
   * By default, automatic flushing is enabled to ensure that events are sent in
   * serverless environments where the runtime may be terminated if the function
   * has returned a value.
   *
   * @default false
   */
  disableAutomaticFlush?: boolean;
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

  protected disableAutomaticFlush = false;

  // Isolation scope from wrapFunctionHandler. Used for scope.captureException
  // instead of Sentry.captureException to avoid relying on async context
  // propagation between engine internals and Sentry's scope resolution.
  #scope?: Sentry.Scope;

  // Shared tags set once in wrapFunctionHandler, reused as attributes on
  // child spans (memoization, execution) for self-contained span metadata.
  #tags: Record<string, string | undefined> = {};

  #runSpan?: Span;
  #memoSpan?: Span;
  #execSpan?: Span;

  // Using a map is overkill right now since we never execute more than one step
  // at a time. But just in case that changes, we'll use a map. Until that
  // changes, the map size will always be 0 or 1.
  #stepSpans = new Map<string, Span>();

  // Tracks whether onRunError or onStepError fired. Used in wrapRequest's
  // finally to set OK status only when no error occurred — necessary because
  // onRunComplete only fires on the final request of a run, not on
  // intermediate requests where a step completed successfully.
  #hasError = false;

  // wrapRequest always resolves (even when wrapFunctionHandler's next()
  // doesn't, e.g. fresh step discovered), making this the only reliable
  // place to end spans and flush.
  override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
    try {
      return await next();
    } finally {
      if (!this.#hasError) {
        this.#runSpan?.setStatus({ code: 1 });
      }

      for (const span of this.#stepSpans.values()) {
        span.end();
      }
      this.#memoSpan?.end();
      this.#execSpan?.end();
      this.#runSpan?.end();

      if (!this.disableAutomaticFlush) {
        await Sentry.flush();
      }
    }
  }

  // Sets up Sentry isolation scope, shared tags, and the root "run" span.
  // Everything inside runs in a dedicated isolation scope so tags and
  // breadcrumbs don't bleed between concurrent function runs.
  override async wrapFunctionHandler({
    next,
    ctx,
    fn,
  }: Middleware.WrapFunctionHandlerArgs) {
    return Sentry.withIsolationScope(async (scope) => {
      this.#scope = scope;

      this.#tags = {
        "inngest.client.id": this.client.id,
        "inngest.function.id": fn.id(this.client.id),
        "inngest.function.name": fn.name,
        "inngest.event.id": ctx.event.id,
        "inngest.event.name": ctx.event.name,
        "inngest.run.id": ctx.runId,
      };

      scope.setTags(this.#tags);
      scope.setTransactionName(`inngest:${fn.name}`);

      return Sentry.startSpanManual(
        {
          name: "Inngest Function Run",
          op: "run",
          attributes: {
            ...this.#tags,
            "inngest.event": JSON.stringify(ctx.event),
          },
          scope,
        },
        async (span) => {
          this.#runSpan = span;

          // Memoization phase starts immediately; ended in onMemoizationEnd.
          Sentry.startSpanManual(
            {
              name: "Memoization",
              op: "memoization",
              attributes: { ...this.#tags },
            },
            (mSpan) => {
              this.#memoSpan = mSpan;
            },
          );

          return await next();
        },
      );
    });
  }

  // Injects ctx.sentry for user code and records the number of memoized
  // steps on the memoization span.
  //
  // The explicit return type enables TypeScript to infer ctx.sentry in
  // function handlers when this middleware is registered on the client.
  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs & {
    ctx: { sentry: typeof Sentry };
  } {
    this.#memoSpan?.setAttributes({
      "inngest.memoization.count": Object.keys(arg.steps).length,
    });

    return { ...arg, ctx: { ...arg.ctx, sentry: Sentry } };
  }

  // Marks the boundary between memoization and fresh execution.
  override onMemoizationEnd() {
    this.#memoSpan?.end();

    Sentry.startSpanManual(
      {
        name: "Execution",
        op: "execution",
        attributes: { ...this.#tags },
      },
      (span) => {
        this.#execSpan = span;
      },
    );
  }

  // Captures function-level errors using the stored isolation scope.
  override onRunError({ error }: Middleware.OnRunErrorArgs) {
    this.#hasError = true;
    this.#runSpan?.setStatus({ code: 2 });

    if (this.#scope) {
      this.#scope.captureException(error);
    } else {
      Sentry.captureException(error);
    }
  }

  // Only set OK if no step error was captured. A caught step error
  // (try-catch in user code) sets #hasError but the function still
  // completes — we preserve the error status so the trace reflects it.
  override onRunComplete() {
    if (!this.#hasError) {
      this.#runSpan?.setStatus({ code: 1 });
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
      name: stepInfo.options?.name ?? "step",
      op: "step",
      attributes: {
        ...this.#tags,
        "inngest.step.id": stepInfo.hashedId,
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
      message: stepInfo.options?.name ?? "",
      data: { type: String(stepInfo.stepType) },
      level: "info",
    });
  }

  override onStepError({ error, stepInfo }: Middleware.OnStepErrorArgs) {
    this.#hasError = true;
    this.#runSpan?.setStatus({ code: 2 });

    const span = this.#stepSpans.get(stepInfo.hashedId);
    if (span) {
      span.setStatus({ code: 2 });
      span.end();
      this.#stepSpans.delete(stepInfo.hashedId);
    }

    this.#scope?.addBreadcrumb({
      category: "inngest.step",
      message: stepInfo.options?.name ?? "",
      data: { type: String(stepInfo.stepType) },
      level: "error",
    });

    if (this.#scope) {
      this.#scope.captureException(error);
    } else {
      Sentry.captureException(error);
    }
  }
}

/**
 * Creates a configured Sentry middleware class.
 *
 * For default behavior, you can pass {@link SentryMiddleware} directly instead.
 */
export const sentryMiddleware = (opts?: SentryMiddlewareOptions) => {
  if (!opts) {
    return SentryMiddleware;
  }

  const { disableAutomaticFlush = false } = opts;

  return class extends SentryMiddleware {
    protected override disableAutomaticFlush = disableAutomaticFlush;
  };
};
