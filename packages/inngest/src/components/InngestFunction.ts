import { internalEvents, queryKeys } from "../helpers/consts";
import { timeStr } from "../helpers/strings";
import { type RecursiveTuple, type StrictUnion } from "../helpers/types";
import {
  type Cancellation,
  type ConcurrencyOption,
  type FunctionConfig,
  type Handler,
  type TimeStr,
  type TimeStrBatch,
  type TriggersFromClient,
} from "../types";
import { type GetEvents, type Inngest } from "./Inngest";
import {
  type InngestMiddleware,
  type MiddlewareRegisterReturn,
} from "./InngestMiddleware";
import {
  ExecutionVersion,
  type IInngestExecution,
  type InngestExecutionOptions,
} from "./execution/InngestExecution";
import { createV0InngestExecution } from "./execution/v0";
import { createV1InngestExecution } from "./execution/v1";

/**
 * A stateless Inngest function, wrapping up function configuration and any
 * in-memory steps to run when triggered.
 *
 * This function can be "registered" to create a handler that Inngest can
 * trigger remotely.
 *
 * @public
 */
export class InngestFunction<
  TFnOpts extends InngestFunction.Options<
    TClient,
    TMiddleware,
    TTriggers,
    TFailureHandler
  >,
  THandler extends Handler.Any,
  TFailureHandler extends Handler.Any,
  TClient extends Inngest.Any = Inngest.Any,
  TMiddleware extends InngestMiddleware.Stack = InngestMiddleware.Stack,
  TTriggers extends InngestFunction.Trigger<
    TriggersFromClient<TClient>
  >[] = InngestFunction.Trigger<TriggersFromClient<TClient>>[],
> {
  static stepId = "step";
  static failureSuffix = "-failure";

  public readonly opts: TFnOpts;
  private readonly fn: THandler;
  private readonly onFailureFn?: TFailureHandler;
  private readonly client: TClient;
  private readonly middleware: Promise<MiddlewareRegisterReturn[]>;

  /**
   * A stateless Inngest function, wrapping up function configuration and any
   * in-memory steps to run when triggered.
   *
   * This function can be "registered" to create a handler that Inngest can
   * trigger remotely.
   */
  constructor(
    client: TClient,

    /**
     * Options
     */
    opts: TFnOpts,
    fn: THandler
  ) {
    this.client = client;
    this.opts = opts;
    this.fn = fn;
    this.onFailureFn = this.opts.onFailure;

    this.middleware = this.client["initializeMiddleware"](
      this.opts.middleware,
      { registerInput: { fn: this }, prefixStack: this.client["middleware"] }
    );
  }

  /**
   * The generated or given ID for this function.
   */
  public id(prefix?: string): string {
    return [prefix, this.opts.id].filter(Boolean).join("-");
  }

  /**
   * The name of this function as it will appear in the Inngest Cloud UI.
   */
  public get name(): string {
    return this.opts.name || this.id();
  }

  /**
   * Retrieve the Inngest config for this function.
   */
  private getConfig(
    /**
     * Must be provided a URL that will be used to access the function and step.
     * This function can't be expected to know how it will be accessed, so
     * relies on an outside method providing context.
     */
    baseUrl: URL,
    appPrefix?: string
  ): FunctionConfig[] {
    const fnId = this.id(appPrefix);
    const stepUrl = new URL(baseUrl.href);
    stepUrl.searchParams.set(queryKeys.FnId, fnId);
    stepUrl.searchParams.set(queryKeys.StepId, InngestFunction.stepId);

    const {
      retries: attempts,
      cancelOn,
      idempotency,
      batchEvents,
      rateLimit,
      throttle,
      concurrency,
      debounce,
      priority,
    } = this.opts;

    /**
     * Convert retries into the format required when defining function
     * configuration.
     */
    const retries = typeof attempts === "undefined" ? undefined : { attempts };

    const fn: FunctionConfig = {
      id: fnId,
      name: this.name,
      triggers: (this.opts.triggers ?? []).map((trigger) => {
        if ("event" in trigger) {
          return {
            event: trigger.event as string,
            expression: trigger.if,
          };
        }

        return {
          cron: trigger.cron,
        };
      }),
      steps: {
        [InngestFunction.stepId]: {
          id: InngestFunction.stepId,
          name: InngestFunction.stepId,
          runtime: {
            type: "http",
            url: stepUrl.href,
          },
          retries,
        },
      },
      idempotency,
      batchEvents,
      rateLimit,
      throttle,
      concurrency,
      debounce,
      priority,
    };

    if (cancelOn) {
      fn.cancel = cancelOn.map(({ event, timeout, if: ifStr, match }) => {
        const ret: NonNullable<FunctionConfig["cancel"]>[number] = {
          event,
        };

        if (timeout) {
          ret.timeout = timeStr(timeout);
        }

        if (match) {
          ret.if = `event.${match} == async.${match}`;
        } else if (ifStr) {
          ret.if = ifStr;
        }

        return ret;
      }, []);
    }

    const config: FunctionConfig[] = [fn];

    if (this.onFailureFn) {
      const id = `${fn.id}${InngestFunction.failureSuffix}`;
      const name = `${fn.name ?? fn.id} (failure)`;

      const failureStepUrl = new URL(stepUrl.href);
      failureStepUrl.searchParams.set(queryKeys.FnId, id);

      config.push({
        id,
        name,
        triggers: [
          {
            event: internalEvents.FunctionFailed,
            expression: `event.data.function_id == '${fnId}'`,
          },
        ],
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: failureStepUrl.href,
            },
            retries: { attempts: 1 },
          },
        },
      });
    }

    return config;
  }

  protected createExecution(opts: CreateExecutionOptions): IInngestExecution {
    const options: InngestExecutionOptions = {
      client: this.client,
      fn: this,
      ...opts.partialOptions,
    };

    const versionHandlers = {
      [ExecutionVersion.V1]: () => createV1InngestExecution(options),
      [ExecutionVersion.V0]: () => createV0InngestExecution(options),
    } satisfies Record<ExecutionVersion, () => IInngestExecution>;

    return versionHandlers[opts.version]();
  }
}

/**
 * A stateless Inngest function, wrapping up function configuration and any
 * in-memory steps to run when triggered.
 *
 * This function can be "registered" to create a handler that Inngest can
 * trigger remotely.
 *
 * @public
 */
export namespace InngestFunction {
  /**
   * Represents any `InngestFunction` instance, regardless of generics and
   * inference.
   */
  export type Any = InngestFunction<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >;

  /**
   * A user-friendly method of specifying a trigger for an Inngest function.
   *
   * @public
   */
  export type Trigger<T extends string> = StrictUnion<
    | {
        event: T;
        if?: string;
      }
    | {
        cron: string;
      }
  >;

  export type GetOptions<T extends InngestFunction.Any> =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends InngestFunction<infer O, any, any, any, any, any> ? O : never;

  /**
   * A set of options for configuring an Inngest function.
   *
   * @public
   */
  export interface Options<
    TClient extends Inngest.Any = Inngest.Any,
    TMiddleware extends InngestMiddleware.Stack = InngestMiddleware.Stack,
    TTriggers extends InngestFunction.Trigger<
      TriggersFromClient<TClient>
    >[] = InngestFunction.Trigger<TriggersFromClient<TClient>>[],
    TFailureHandler extends Handler.Any = Handler.Any,
  > {
    triggers?: TTriggers;

    /**
     * An unique ID used to identify the function. This is used internally for
     * versioning and referring to your function, so should not change between
     * deployments.
     *
     * If you'd like to set a prettier name for your function, use the `name`
     * option.
     */
    id: string;

    /**
     * A name for the function as it will appear in the Inngest Cloud UI.
     */
    name?: string;

    /**
     * Concurrency specifies a limit on the total number of concurrent steps that
     * can occur across all runs of the function.  A value of 0 (or undefined) means
     * use the maximum available concurrency.
     *
     * Specifying just a number means specifying only the concurrency limit. A
     * maximum of two concurrency options can be specified.
     */
    concurrency?:
      | number
      | ConcurrencyOption
      | RecursiveTuple<ConcurrencyOption, 2>;

    /**
     * batchEvents specifies the batch configuration on when this function
     * should be invoked when one of the requirements are fulfilled.
     */
    batchEvents?: {
      /**
       * The maximum number of events to be consumed in one batch,
       * Currently allowed max value is 100.
       */
      maxSize: number;

      /**
       * How long to wait before invoking the function with a list of events.
       * If timeout is reached, the function will be invoked with a batch
       * even if it's not filled up to `maxSize`.
       *
       * Expects 1s to 60s.
       */
      timeout: TimeStrBatch;

      /**
       * An optional key to use for batching.
       *
       * See [batch documentation](https://innge.st/batching) for more
       * information on how to use `key` expressions.
       */
      key?: string;
    };

    /**
     * Allow the specification of an idempotency key using event data. If
     * specified, this overrides the `rateLimit` object.
     */
    idempotency?: string;

    /**
     * Rate limit function runs, only running them a given number of times (limit) per
     * period.  Note that rate limit is a lossy, hard limit.  Once the limit is hit,
     * new runs will be skipped.  To enqueue work when a rate limit is hit, use the
     * {@link throttle} parameter.
     */
    rateLimit?: {
      /**
       * An optional key to use for rate limiting, similar to idempotency.
       */
      key?: string;

      /**
       * The number of times to allow the function to run per the given `period`.
       */
      limit: number;

      /**
       * The period of time to allow the function to run `limit` times.
       */
      period: TimeStr;
    };

    /**
     * Throttles function runs, only running them a given number of times (limit) per
     * period.  Once the limit is hit, new runs will be enqueued and will start when there's
     * capacity.  This may lead to a large backlog.  For hard rate limiting, use the
     * {@link rateLimit} parameter.
     */
    throttle?: {
      /**
       *  An optional expression which returns a throttling key for controlling throttling.
       *  Every unique key is its own throttle limit.  Event data may be used within this
       *  expression, eg "event.data.user_id".
       */
      key?: string;

      /**
       * The total number of runs allowed to start within the given `period`.  The limit is
       * applied evenly over the period.
       */
      limit: number;

      /**
       * The period of time for the rate limit.  Run starts are evenly spaced through
       * the given period.  The minimum granularity is 1 second.
       */
      period: TimeStr;

      /**
       * The number of runs allowed to start in the given window in a single burst.
       * A burst > 1 bypasses smoothing for the burst and allows many runs to start
       * at once, if desired.  Defaults to 1, which disables bursting.
       */
      burst?: number;
    };

    /**
     * Debounce delays functions for the `period` specified. If an event is sent,
     * the function will not run until at least `period` has elapsed.
     *
     * If any new events are received that match the same debounce `key`, the
     * function is rescheduled for another `period` delay, and the triggering
     * event is replaced with the latest event received.
     *
     * See the [Debounce documentation](https://innge.st/debounce) for more
     * information.
     */
    debounce?: {
      /**
       * An optional key to use for debouncing.
       *
       * See [Debounce documentation](https://innge.st/debounce) for more
       * information on how to use `key` expressions.
       */
      key?: string;

      /**
       * The period of time to delay after receiving the last trigger to run the
       * function.
       *
       * See [Debounce documentation](https://innge.st/debounce) for more
       * information.
       */
      period: TimeStr;

      /**
       * The maximum time that a debounce can be extended before running.
       * If events are continually received within the given period, a function
       * will always run after the given timeout period.
       *
       * See [Debounce documentation](https://innge.st/debounce) for more
       * information.
       */
      timeout?: TimeStr;
    };

    /**
     * Configure how the priority of a function run is decided when multiple
     * functions are triggered at the same time.
     *
     * See the [Priority documentation](https://innge.st/priority) for more
     * information.
     */
    priority?: {
      /**
       * An expression to use to determine the priority of a function run. The
       * expression can return a number between `-600` and `600`, where `600`
       * declares that this run should be executed before any others enqueued in
       * the last 600 seconds (10 minutes), and `-600` declares that this run
       * should be executed after any others enqueued in the last 600 seconds.
       *
       * See the [Priority documentation](https://innge.st/priority) for more
       * information.
       */
      run?: string;
    };

    cancelOn?: Cancellation<GetEvents<TClient, true>>[];

    /**
     * Specifies the maximum number of retries for all steps across this function.
     *
     * Can be a number from `0` to `20`. Defaults to `3`.
     */
    retries?:
      | 0
      | 1
      | 2
      | 3
      | 4
      | 5
      | 6
      | 7
      | 8
      | 9
      | 10
      | 11
      | 12
      | 13
      | 14
      | 15
      | 16
      | 17
      | 18
      | 19
      | 20;

    /**
     * Provide a function to be called if your function fails, meaning
     * that it ran out of retries and was unable to complete successfully.
     *
     * This is useful for sending warning notifications or cleaning up
     * after a failure and supports all the same functionality as a
     * regular handler.
     */
    onFailure?: TFailureHandler;

    /**
     * Define a set of middleware that can be registered to hook into
     * various lifecycles of the SDK and affect input and output of
     * Inngest functionality.
     *
     * See {@link https://innge.st/middleware}
     *
     * @example
     *
     * ```ts
     * export const inngest = new Inngest({
     *   middleware: [
     *     new InngestMiddleware({
     *       name: "My Middleware",
     *       init: () => {
     *         // ...
     *       }
     *     })
     *   ]
     * });
     * ```
     */
    middleware?: TMiddleware;
  }
}

export type CreateExecutionOptions = {
  version: ExecutionVersion;
  partialOptions: Omit<InngestExecutionOptions, "client" | "fn">;
};
