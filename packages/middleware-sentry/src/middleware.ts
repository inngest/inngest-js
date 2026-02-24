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
 * This imports Sentry directly and relies on it already being initialized using
 * `Sentry.init()`. For more information on how to configure Sentry, see the
 * [Sentry documentation](https://docs.sentry.io/platforms/node/).
 */
export const sentryMiddleware = (
  opts?: SentryMiddlewareOptions,
): Middleware.Class => {
  class SentryMiddleware extends Middleware.BaseMiddleware {
    readonly id = "inngest:sentry";

    private scope?: Sentry.Scope;
    private runSpan?: Span;
    private memoSpan?: Span;
    private execSpan?: Span;

    // Cleanup only — wrapRequest.next() always resolves, so this
    // is the reliable place to end the parent span and flush.
    override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
      try {
        return await next();
      } finally {
        this.execSpan?.end();
        this.runSpan?.end();

        if (!opts?.disableAutomaticFlush) {
          await Sentry.flush();
        }
      }
    }

    // Set up isolation scope, tags, and spans — wrapFunctionHandler
    // has access to ctx so we can read event + runId data here.
    override async wrapFunctionHandler({
      next,
      ctx,
      fn,
    }: Middleware.WrapFunctionHandlerArgs) {
      return Sentry.withIsolationScope(async (scope) => {
        this.scope = scope;

        const tags = {
          "inngest.client.id": this.client.id,
          "inngest.function.id": fn.id(this.client.id),
          "inngest.function.name": fn.name,
          "inngest.event.id": ctx.event.id,
          "inngest.event.name": ctx.event.name,
          "inngest.run.id": ctx.runId,
        };

        scope.setTags(tags);
        scope.setTransactionName(`inngest:${fn.name}`);

        return Sentry.startSpanManual(
          {
            name: "Inngest Function Run",
            op: "run",
            attributes: {
              ...tags,
              "inngest.event": JSON.stringify(ctx.event),
            },
            scope,
          },
          async (span) => {
            this.runSpan = span;

            // Start memoization span immediately
            Sentry.startSpanManual(
              { name: "Memoization", op: "memoization" },
              (mSpan) => {
                this.memoSpan = mSpan;
              },
            );

            return await next();
          },
        );
      });
    }

    // Inject ctx.sentry and set memoization count on the run span.
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      this.runSpan?.setAttributes({
        "inngest.memoization.count": Object.keys(arg.steps).length,
      });

      return { ...arg, ctx: { ...arg.ctx, sentry: Sentry } };
    }

    override onMemoizationEnd() {
      this.memoSpan?.end();

      Sentry.startSpanManual({ name: "Execution", op: "execution" }, (span) => {
        this.execSpan = span;
      });
    }

    override onRunError({ error }: Middleware.OnRunErrorArgs) {
      this.runSpan?.setStatus({ code: 2 });
      Sentry.captureException(error);
    }

    override onRunComplete() {
      this.runSpan?.setStatus({ code: 1 });
    }

    override onStepComplete({ stepInfo }: Middleware.OnStepCompleteArgs) {
      this.scope?.setTags({
        "inngest.step.name": stepInfo.options?.name ?? "",
        "inngest.step.type": String(stepInfo.stepType),
      });
    }

    override onStepError({ error, stepInfo }: Middleware.OnStepErrorArgs) {
      this.runSpan?.setStatus({ code: 2 });
      this.scope?.setTags({
        "inngest.step.name": stepInfo.options?.name ?? "",
        "inngest.step.type": String(stepInfo.stepType),
      });
      Sentry.captureException(error);
    }
  }

  return SentryMiddleware;
};
