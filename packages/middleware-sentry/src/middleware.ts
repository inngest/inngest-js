import * as Sentry from "@sentry/core";
import { type Span } from "@sentry/types";
import {
  InngestMiddleware,
  type MiddlewareRegisterFn,
  type MiddlewareRegisterReturn,
} from "inngest";

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

  /**
   * If `true`, the Sentry middleware will include the event.data.* keys as tags
   * in Sentry.
   *
   * @default false
   */
  includeDataAsTags?: boolean;
}

/**
 * Captures errors and performance data from Inngest functions and sends them to
 * Sentry.
 *
 * Use the `sentryMiddleware()` helper to create a new Sentry middleware.
 *
 * This type is used an explicit return type for the `sentryMiddleware` function
 * to allow better JSR publishing.
 */
export type SentryMiddleware = InngestMiddleware<{
  name: string;
  init: (...args: Parameters<MiddlewareRegisterFn>) => {
    onFunctionRun: (
      ...args: Parameters<
        NonNullable<MiddlewareRegisterReturn["onFunctionRun"]>
      >
    ) => {
      transformInput: () => {
        ctx: {
          /**
           * The Sentry client fetched by `import * as Sentry from "@sentry/node"`.
           */
          sentry: typeof Sentry;
        };
      };
    };
  };
}>;

/**
 * Captures errors and performance data from Inngest functions and sends them to
 * Sentry.
 *
 * This imports Sentry directly and relies on it already being initialized using
 * `Sentry.init()`. For more information on how to configure Sentry, see the
 * [Sentry documentation](https://docs.sentry.io/platforms/node/).
 */
export const sentryMiddleware = (
  /**
   * Options used to configure the Sentry middleware.
   */
  opts?: SentryMiddlewareOptions,
): SentryMiddleware => {
  const mw = new InngestMiddleware({
    name: "@inngest/middleware-sentry",
    init({ client }) {
      return {
        onFunctionRun({ ctx, fn, steps }) {
          return Sentry.withIsolationScope((scope) => {
            const sharedTags: Record<string, string | undefined> = {
              "inngest.client.id": client.id,
              "inngest.function.id": fn.id(client.id),
              "inngest.function.name": fn.name,
              "inngest.event.id": ctx.event.id,
              "inngest.event.name": ctx.event.name,
              "inngest.run.id": ctx.runId,
            };

            if (opts?.includeDataAsTags && ctx.event?.data) {
              Object.entries(ctx.event.data).forEach(([key, value]) => {
                if (value !== null && value !== undefined) {
                  sharedTags[`inngest.data.${key}`] =
                    typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value);
                }
              });
            }

            scope.setTags(sharedTags);

            let memoSpan: Span;
            let execSpan: Span;

            return Sentry.startSpanManual(
              {
                name: "Inngest Function Run",
                op: "run",
                attributes: {
                  ...sharedTags,
                  "inngest.event": JSON.stringify(ctx.event),
                },
                scope,
              },
              (reqSpan) => {
                return {
                  transformInput() {
                    return {
                      ctx: {
                        sentry: Sentry,
                      },
                    };
                  },
                  beforeMemoization() {
                    Sentry.withActiveSpan(reqSpan, (scope) => {
                      Sentry.startSpanManual(
                        {
                          name: "Memoization",
                          op: "memoization",
                          attributes: {
                            ...sharedTags,
                            "inngest.memoization.count": steps.length,
                          },
                          scope,
                        },
                        (_memoSpan) => {
                          memoSpan = _memoSpan;
                        },
                      );
                    });
                  },
                  afterMemoization() {
                    memoSpan?.end();
                  },
                  beforeExecution() {
                    Sentry.withActiveSpan(reqSpan, (scope) => {
                      Sentry.startSpanManual(
                        {
                          name: "Execution",
                          op: "execution",
                          attributes: {
                            ...sharedTags,
                          },
                          scope,
                        },
                        (_execSpan) => {
                          execSpan = _execSpan;
                        },
                      );
                    });
                  },
                  afterExecution() {
                    execSpan?.end();
                  },
                  transformOutput({ result, step }) {
                    // Set step metadata
                    if (step) {
                      Sentry.withActiveSpan(reqSpan, (scope) => {
                        sharedTags["inngest.step.name"] =
                          step.displayName ?? "";
                        sharedTags["inngest.step.op"] = step.op;

                        scope.setTags(sharedTags);
                      });
                    }

                    // Capture step output and log errors
                    if (result.error) {
                      reqSpan.setStatus({
                        code: 2,
                      });

                      Sentry.withActiveSpan(reqSpan, (scope) => {
                        scope.setTags(sharedTags);
                        scope.setTransactionName(`inngest:${fn.name}`);
                        scope.captureException(result.error);
                      });
                    } else {
                      reqSpan.setStatus({
                        code: 1,
                      });
                    }
                  },
                  async beforeResponse() {
                    reqSpan.end();

                    if (!opts?.disableAutomaticFlush) {
                      await Sentry.flush();
                    }
                  },
                };
              },
            );
          });
        },
      };
    },
  });

  return mw as SentryMiddleware;
};
