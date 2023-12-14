import { type Simplify } from "type-fest";
import { z } from "zod";
import { type EventSchemas } from "./components/EventSchemas";
import {
  type AnyInngest,
  type EventsFromOpts,
  type Inngest,
  type builtInMiddleware,
} from "./components/Inngest";
import {
  type AnyInngestFunction,
  type InngestFunction,
} from "./components/InngestFunction";
import {
  type ExtendSendEventWithMiddleware,
  type InngestMiddleware,
  type MiddlewareOptions,
} from "./components/InngestMiddleware";
import { type createStepTools } from "./components/InngestStepTools";
import { type internalEvents } from "./helpers/consts";
import {
  type IsStringLiteral,
  type ObjectPaths,
  type StrictUnion,
} from "./helpers/types";
import { type Logger } from "./middleware/logger";

/**
 * When passed an Inngest client, will return all event types for that client.
 *
 * It's recommended to use this instead of directly reusing your event types, as
 * Inngest will add extra properties and internal events such as `ts` and
 * `inngest/function.failed`.
 *
 * @example
 * ```ts
 * import { EventSchemas, Inngest, type GetEvents } from "inngest";
 *
 * export const inngest = new Inngest({
 *   name: "Example App",
 *   schemas: new EventSchemas().fromRecord<{
 *     "app/user.created": { data: { userId: string } };
 *   }>(),
 * });
 *
 * type Events = GetEvents<typeof inngest>;
 * type AppUserCreated = Events["app/user.created"];
 *
 * ```
 *
 * @public
 */
export type GetEvents<T extends AnyInngest> = T extends Inngest<infer U>
  ? EventsFromOpts<U>
  : never;

export const failureEventErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  cause: z.string().optional(),
  status: z.number().optional(),
});

export type MiddlewareStack = [
  InngestMiddleware<MiddlewareOptions>,
  ...InngestMiddleware<MiddlewareOptions>[],
];

/**
 * The payload for an internal Inngest event that is sent when a function fails.
 *
 * @public
 */
export type FailureEventPayload<P extends EventPayload = EventPayload> = {
  name: `${internalEvents.FunctionFailed}`;
  data: {
    function_id: string;
    run_id: string;
    error: z.output<typeof failureEventErrorSchema>;
    event: P;
  };
};

/**
 * Context arguments specific to a failure event.
 *
 * @public
 */
export type FailureEventArgs<P extends EventPayload = EventPayload> = {
  /**
   * The event data present in the payload.
   */
  event: FailureEventPayload<P>;

  /**
   * The final error that caused this function to exhaust all retries.
   */
  error: Error;
};

export type FinishedEventPayload = {
  name: `${internalEvents.FunctionFinished}`;
  data: {
    function_id: string;
    run_id: string;
    correlation_id?: string;
  } & (
    | {
        error: z.output<typeof failureEventErrorSchema>;
      }
    | {
        result: unknown;
      }
  );
};

/**
 * Unique codes for the different types of operation that can be sent to Inngest
 * from SDK step functions.
 */
export enum StepOpCode {
  WaitForEvent = "WaitForEvent",
  RunStep = "Step",
  StepPlanned = "StepPlanned",
  Sleep = "Sleep",

  /**
   * Used to signify that the executor has requested that a step run, but we
   * could not find that step.
   *
   * This is likely indicative that a step was renamed or removed from the
   * function.
   */
  StepNotFound = "StepNotFound",

  InvokeFunction = "InvokeFunction",
}

/**
 * The shape of a single operation in a step function. Used to communicate
 * desired and received operations to Inngest.
 */
export type Op = {
  /**
   * The unique code for this operation.
   */
  op: StepOpCode;

  /**
   * The unhashed step name for this operation. This is a legacy field that is
   * sometimes used for critical data, like the sleep duration for
   * `step.sleep()`.
   *
   * @deprecated For display name, use `displayName` instead.
   */
  name?: string;

  /**
   * An optional name for this step that can be used to display in the Inngest
   * UI.
   */
  displayName?: string;

  /**
   * Any additional data required for this operation to send to Inngest. This
   * is not compared when confirming that the operation was completed; use `id`
   * for this.
   */
  opts?: Record<string, unknown>;

  /**
   * Any data present for this operation. If data is present, this operation is
   * treated as completed.
   */
  data?: unknown;

  /**
   * An error present for this operation. If an error is present, this operation
   * is treated as completed, but failed. When this is read from the op stack,
   * the SDK will throw the error via a promise rejection when it is read.
   *
   * This allows users to handle step failures using common tools such as
   * try/catch or `.catch()`.
   */
  error?: unknown;
};

export const incomingOpSchema = z.object({
  id: z.string().min(1),
  data: z.any().optional(),
  error: z.any().optional(),
});

export type IncomingOp = z.output<typeof incomingOpSchema>;
export type OutgoingOp = Pick<
  HashedOp,
  "id" | "op" | "name" | "opts" | "data" | "error" | "displayName"
>;

/**
 * The shape of a hashed operation in a step function. Used to communicate
 * desired and received operations to Inngest.
 */
export type HashedOp = Op & {
  /**
   * The hashed identifier for this operation, used to confirm that the
   * operation was completed when it is received from Inngest.
   */
  id: string;
};

/**
 * A helper type to represent a stack of operations that will accumulate
 * throughout a step function's run.  This stack contains an object of
 * op hashes to data.
 */
export type OpStack = IncomingOp[];

/**
 * A function that can be used to submit an operation to Inngest internally.
 */
export type SubmitOpFn = (op: Op) => void;

/**
 * A sleep-compatible time string such as `"1h30m15s"` that can be sent to
 * Inngest to sleep for a given amount of time.
 *
 * This type includes an empty string too, so make sure to exclude that via
 * `Exclude<TimeStr, "">` if you don't want to allow empty strings.
 *
 * @public
 */
export type TimeStr = `${`${number}w` | ""}${`${number}d` | ""}${
  | `${number}h`
  | ""}${`${number}m` | ""}${`${number}s` | ""}`;

export type TimeStrBatch = `${`${number}s`}`;

/**
 * Mutates an {@link EventPayload} `T` to include invocation events.
 */
export type WithInvocation<T extends EventPayload> = Simplify<
  { name: T["name"] | `${internalEvents.FunctionInvoked}` } & Omit<T, "name">
>;

export type BaseContext<
  TOpts extends ClientOptions,
  TTrigger extends keyof EventsFromOpts<TOpts> & string,
> = {
  /**
   * The event data present in the payload.
   */
  event: WithInvocation<EventsFromOpts<TOpts>[TTrigger]>;

  events: [
    EventsFromOpts<TOpts>[TTrigger],
    ...EventsFromOpts<TOpts>[TTrigger][],
  ];

  /**
   * The run ID for the current function execution
   */
  runId: string;

  step: ReturnType<
    typeof createStepTools<TOpts, EventsFromOpts<TOpts>, TTrigger>
  >;

  /**
   * The current zero-indexed attempt number for this function execution. The
   * first attempt will be `0`, the second `1`, and so on. The attempt number
   * is incremented every time the function throws an error and is retried.
   */
  attempt: number;
};

/**
 * Builds a context object for an Inngest handler, optionally overriding some
 * keys.
 */
export type Context<
  TOpts extends ClientOptions,
  TEvents extends Record<string, EventPayload>,
  TTrigger extends keyof TEvents & string,
  TOverrides extends Record<string, unknown> = Record<never, never>,
> = Omit<BaseContext<TOpts, TTrigger>, keyof TOverrides> & TOverrides;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyContext = Context<any, any, any>;

/**
 * The shape of a Inngest function, taking in event, step, ctx, and step
 * tooling.
 *
 * @public
 */
export type Handler<
  TOpts extends ClientOptions,
  TEvents extends EventsFromOpts<TOpts>,
  TTrigger extends keyof TEvents & string,
  TOverrides extends Record<string, unknown> = Record<never, never>,
> = (
  /**
   * The context argument provides access to all data and tooling available to
   * the function.
   */
  ctx: Context<TOpts, TEvents, TTrigger, TOverrides>
) => unknown;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHandler = Handler<any, any, any, any>;

/**
 * The shape of a single event's payload. It should be extended to enforce
 * adherence to given events and not used as a method of creating them (i.e. as
 * a generic).
 *
 * @public
 */
export interface EventPayload {
  /**
   * A unique id used to idempotently process a given event payload.
   *
   * Set this when sending events to ensure that the event is only processed
   * once; if an event with the same ID is sent again, it will not invoke
   * functions.
   */
  id?: string;

  /**
   * A unique identifier for the type of event. We recommend using lowercase dot
   * notation for names, prepending `prefixes/` with a slash for organization.
   *
   * e.g. `cloudwatch/alarms/triggered`, `cart/session.created`
   */
  name: string;

  /**
   * Any data pertinent to the event
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;

  /**
   * Any user data associated with the event
   * All fields ending in "_id" will be used to attribute the event to a particular user
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user?: any;

  /**
   * A specific event schema version
   * (optional)
   */
  v?: string;

  /**
   * An integer representing the milliseconds since the unix epoch at which this
   * event occurred.
   *
   * Defaults to the current time.
   * (optional)
   */
  ts?: number;
}

export const sendEventResponseSchema = z.object({
  /**
   * Event IDs
   */
  ids: z.array(z.string()),

  /**
   * HTTP Status Code. Will be undefined if no request was sent.
   */
  status: z.number(),

  /**
   * Error message. Will be undefined if no error occurred.
   */
  error: z.string().optional(),
});

/**
 * The response from the Inngest Event API
 */
export type SendEventResponse = z.output<typeof sendEventResponseSchema>;

/**
 * The response in code from sending an event to Inngest.
 */
export type SendEventBaseOutput = {
  ids: SendEventResponse["ids"];
};

export type SendEventOutput<TOpts extends ClientOptions> = Omit<
  SendEventBaseOutput,
  keyof SendEventOutputWithMiddleware<TOpts>
> &
  SendEventOutputWithMiddleware<TOpts>;

export type SendEventOutputWithMiddleware<TOpts extends ClientOptions> =
  ExtendSendEventWithMiddleware<
    [typeof builtInMiddleware, NonNullable<TOpts["middleware"]>],
    SendEventBaseOutput
  >;

/**
 * An HTTP-like, standardised response format that allows Inngest to help
 * orchestrate steps and retries.
 *
 * @internal
 */
export interface Response {
  /**
   * A step response must contain an HTTP status code.
   *
   * A `2xx` response indicates success; this is not a failure and no retry is
   * necessary.
   *
   * A `4xx` response indicates a bad request; this step will not be retried as
   * it is deemed irrecoverable. Examples of this might be an event with
   * insufficient data or concerning a user that no longer exists.
   *
   * A `5xx` status indicates a temporary internal error; this will be retried
   * according to the step and function's retry policy (3 times, by default).
   *
   * {@link https://www.inngest.com/docs/functions/function-input-and-output#response-format}
   * {@link https://www.inngest.com/docs/functions/retries}
   */
  status: number;

  /**
   * The output of the function - the `body` - can be any arbitrary
   * JSON-compatible data. It is then usable by any future steps.
   *
   * {@link https://www.inngest.com/docs/functions/function-input-and-output#response-format}
   */
  body?: unknown;
}

/**
 * A single step within a function.
 *
 * @internal
 */
export type Step<TContext = unknown> = (
  /**
   * The context for this step, including the triggering event and any previous
   * step output.
   */
  context: TContext
) => Promise<Response> | Response;

/**
 * A set of options for configuring the Inngest client.
 *
 * @public
 */
export interface ClientOptions {
  /**
   * The ID of this instance, most commonly a reference to the application it
   * resides in.
   *
   * The ID of your client should remain the same for its lifetime; if you'd
   * like to change the name of your client as it appears in the Inngest UI,
   * change the `name` property instead.
   */
  id: string;

  /**
   * Inngest event key, used to send events to Inngest Cloud. If not provided,
   * will search for the `INNGEST_EVENT_KEY` environment variable. If neither
   * can be found, however, a warning will be shown and any attempts to send
   * events will throw an error.
   */
  eventKey?: string;

  /**
   * The base URL to use when contacting Inngest.
   *
   * Defaults to https://inn.gs/ for sending events and https://api.inngest.com
   * for all other communication with Inngest.
   */
  baseUrl?: string;

  /**
   * If provided, will override the used `fetch` implementation. Useful for
   * giving the library a particular implementation if accessing it is not done
   * via globals.
   *
   * By default the library will try to use the native Web API fetch, falling
   * back to a Node implementation if no global fetch can be found.
   */
  fetch?: typeof fetch;

  /**
   * Provide an `EventSchemas` class to type events, providing type safety when
   * sending events and running functions via Inngest.
   *
   * You can provide generated Inngest types, custom types, types using Zod, or
   * a combination of the above. See {@link EventSchemas} for more information.
   *
   * @example
   *
   * ```ts
   * export const inngest = new Inngest({
   *   name: "My App",
   *   schemas: new EventSchemas().fromZod({
   *     "app/user.created": {
   *       data: z.object({
   *         id: z.string(),
   *         name: z.string(),
   *       }),
   *     },
   *   }),
   * });
   * ```
   */
  schemas?: EventSchemas<Record<string, EventPayload>>;

  /**
   * The Inngest environment to send events to. Defaults to whichever
   * environment this client's event key is associated with.
   *
   * It's likely you never need to change this unless you're trying to sync
   * multiple systems together using branch names.
   */
  env?: string;

  /**
   * The logger provided by the user.
   * The user can passed in their winston, pino, and other loggers for
   * handling log delivery to external services.
   *
   * The provider logger is expected to implement the following API interfaces
   * - .info()
   * - .warn()
   * - .debug()
   * - .error()
   * which most loggers already do.
   *
   * Defaults to a dummy logger that just log things to the console if nothing is provided.
   */
  logger?: Logger;
  middleware?: MiddlewareStack;
}

/**
 * A set of log levels that can be used to control the amount of logging output
 * from various parts of the Inngest library.
 *
 * @public
 */
export const logLevels = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "silent",
] as const;

/**
 * A set of log levels that can be used to control the amount of logging output
 * from various parts of the Inngest library.
 *
 * @public
 */
export type LogLevel = (typeof logLevels)[number];

/**
 * A set of options for configuring the registration of Inngest functions.
 *
 * @public
 */
export interface RegisterOptions {
  /**
   * A key used to sign requests to and from Inngest in order to prove that the
   * source is legitimate.
   *
   * You must provide a signing key to communicate securely with Inngest. If
   * your key is not provided here, we'll try to retrieve it from the
   * `INNGEST_SIGNING_KEY` environment variable.
   *
   * You can retrieve your signing key from the Inngest UI inside the "Secrets"
   * section at {@link https://app.inngest.com/secrets}. We highly recommend
   * that you add this to your platform's available environment variables as
   * `INNGEST_SIGNING_KEY`.
   *
   * If no key can be found, you will not be able to register your functions or
   * receive events from Inngest.
   */
  signingKey?: string;

  /**
   * The URL used to register functions with Inngest.
   * Defaults to https://api.inngest.com/fn/register
   */
  baseUrl?: string;

  /**
   * If provided, will override the used `fetch` implementation. Useful for
   * giving the library a particular implementation if accessing it is not done
   * via globals.
   *
   * By default the library will try to use the native Web API fetch, falling
   * back to a Node implementation if no global fetch can be found.
   */
  fetch?: typeof fetch;

  /**
   * The path to the Inngest serve endpoint. e.g.:
   *
   *     "/some/long/path/to/inngest/endpoint"
   *
   * By default, the library will try to infer this using request details such
   * as the "Host" header and request path, but sometimes this isn't possible
   * (e.g. when running in a more controlled environments such as AWS Lambda or
   * when dealing with proxies/rediects).
   *
   * Provide the custom path (excluding the hostname) here to ensure that the
   * path is reported correctly when registering functions with Inngest.
   *
   * To also provide a custom hostname, use `serveHost`.
   */
  servePath?: string;

  /**
   * The host used to access the Inngest serve endpoint, e.g.:
   *
   *     "https://myapp.com"
   *
   * By default, the library will try to infer this using request details such
   * as the "Host" header and request path, but sometimes this isn't possible
   * (e.g. when running in a more controlled environments such as AWS Lambda or
   * when dealing with proxies/redirects).
   *
   * Provide the custom hostname here to ensure that the path is reported
   * correctly when registering functions with Inngest.
   *
   * To also provide a custom path, use `servePath`.
   */
  serveHost?: string;

  /**
   * The minimum level to log from the Inngest serve endpoint.
   *
   * Default level: "info"
   */
  logLevel?: LogLevel;

  /**
   * Some serverless providers (especially those with edge compute) may support
   * streaming responses back to Inngest. This can be used to circumvent
   * restrictive request timeouts and other limitations. It is only available if
   * the serve handler being used supports streaming.
   *
   * If this is `"allow"`, the SDK will attempt to stream responses back to
   * Inngest if it can confidently detect support for it by verifyng that the
   * platform and the serve handler supports streaming.
   *
   * If this is `"force"`, the SDK will always attempt to stream responses back
   * to Inngest regardless of whether we can detect support for it or not. This
   * will override `allowStreaming`, but will still not attempt to stream if
   * the serve handler does not support it.
   *
   * If this is `false`, streaming will never be used.
   *
   * Defaults to `false`.
   */
  streaming?: "allow" | "force" | false;

  /**
   * The ID of this app. This is used to group functions together in the Inngest
   * UI. The ID of the passed client is used by default.
   */
  id?: string;
}

/**
 * A user-friendly method of specifying a trigger for an Inngest function.
 *
 * @public
 */
export type TriggerOptions<T extends string> = StrictUnion<
  | {
      event: T;
      if?: string;
    }
  | {
      cron: string;
    }
>;

export interface ConcurrencyOption {
  /**
   * The concurrency limit for this option, adding a limit on how many concurrent
   * steps can execute at once.
   */
  limit: number;

  /**
   * An optional concurrency key, as an expression using the common expression language
   * (CEL).  The result of this expression is used to create new concurrency groups, or
   * sub-queues, for each function run.
   *
   * The event is passed into this expression as "event".
   *
   * Examples:
   * - `event.data.user_id`:  this evaluates to the user_id in the event.data object.
   * - `event.data.user_id + "-" + event.data.account_id`: creates a new group per user/account
   * - `"ai"`:  references a custom string
   */
  key?: string;

  /**
   * An optional scope for the concurrency group.  By default, concurrency limits are
   * scoped to functions - one function's concurrency limits do not impact other functions.
   *
   * Changing this "scope" allows concurrency limits to work across environments (eg. production
   * vs branch environments) or across your account (global).
   */
  scope?: "fn" | "env" | "account";
}

/**
 * A set of options for configuring an Inngest function.
 *
 * @public
 */
export interface FunctionOptions<
  Events extends Record<string, EventPayload>,
  Event extends keyof Events & string,
> {
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
   * Specifying just a number means specifying only the concurrency limit.
   */
  concurrency?:
    | number
    | ConcurrencyOption
    | [ConcurrencyOption, ConcurrencyOption];

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
  };

  /**
   * Allow the specification of an idempotency key using event data. If
   * specified, this overrides the `rateLimit` object.
   */
  idempotency?: string;

  /**
   * Rate limit workflows, only running them a given number of times (limit) per
   * period. This can optionally include a `key`, which is used to further
   * constrain throttling similar to idempotency.
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
   * Debounce delays functions for the `period` specified. If an event is sent,
   * the function will not run until at least `period` has elapsed.
   *
   * If any new events are received that match the same debounce `key`, the
   * function is reshceduled for another `period` delay, and the triggering
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
     * The period of time to after receiving the last trigger to run the
     * function.
     *
     * See [Debounce documentation](https://innge.st/debounce) for more
     * information.
     */
    period: TimeStr;
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

  cancelOn?: Cancellation<Events, Event>[];

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

  onFailure?: (...args: unknown[]) => unknown;

  /**
   * Define a set of middleware that can be registered to hook into various
   * lifecycles of the SDK and affect input and output of Inngest functionality.
   *
   * See {@link https://innge.st/middleware}
   */
  middleware?: MiddlewareStack;
}

/**
 * Configuration for cancelling a function run based on an incoming event.
 *
 * @public
 */
export type Cancellation<
  Events extends Record<string, EventPayload>,
  TriggeringEvent extends keyof Events & string,
> = {
  [K in keyof Events & string]: {
    /**
     * The name of the event that should cancel the function run.
     */
    event: K;

    /**
     * The expression that must evaluate to true in order to cancel the function run. There
     * are two variables available in this expression:
     * - event, referencing the original function's event trigger
     * - async, referencing the new cancel event.
     *
     * @example
     *
     * Ensures the cancel event's data.user_id field matches the triggering event's data.user_id
     * field:
     *
     * ```ts
     * "async.data.user_id == event.data.user_id"
     * ```
     */
    if?: string;

    /**
     * If provided, the step function will wait for the incoming event to match
     * particular criteria. If the event does not match, it will be ignored and
     * the step function will wait for another event.
     *
     * It must be a string of a dot-notation field name within both events to
     * compare, e.g. `"data.id"` or `"user.email"`.
     *
     * ```
     * // Wait for an event where the `user.email` field matches
     * match: "user.email"
     * ```
     *
     * All of these are helpers for the `if` option, which allows you to specify
     * a custom condition to check. This can be useful if you need to compare
     * multiple fields or use a more complex condition.
     *
     * See the Inngest expressions docs for more information.
     *
     * {@link https://www.inngest.com/docs/functions/expressions}
     */
    match?: IsStringLiteral<keyof Events & string> extends true
      ? ObjectPaths<Events[TriggeringEvent]> & ObjectPaths<Events[K]>
      : string;

    /**
     * An optional timeout that the cancel is valid for.  If this isn't
     * specified, cancellation triggers are valid for up to a year or until the
     * function ends.
     *
     * The time to wait can be specified using a `number` of milliseconds, an
     * `ms`-compatible time string like `"1 hour"`, `"30 mins"`, or `"2.5d"`, or
     * a `Date` object.
     *
     * {@link https://npm.im/ms}
     */
    timeout?: number | string | Date;
  };
}[keyof Events & string];

/**
 * The response to send to Inngest when pushing function config either directly
 * or when pinged by Inngest Cloud.
 *
 * @internal
 */
export interface RegisterRequest {
  /**
   * The API handler's URL to invoke SDK based functions.
   */
  url: string;

  /**
   * Response version, allowing Inngest to change any top-level field.
   */
  v: `${number}.${number}`;

  /**
   * SDK version from `package.json` for our internal metrics and to warn users
   * they need to upgrade.
   */
  sdk: `js:v${number}.${number}.${number}${"" | `-${string}.${number}`}`;

  /**
   * The method used to deploy these functions.
   */
  deployType: "ping";

  /**
   * The name of the framework being used for this instance, e.g. "nextjs",
   * "vercel", "netlify", "lambda", etc. Uses the `framework` specified when
   * creating a new `InngestCommHandler`.
   */
  framework: string;

  /**
   * The name of this particular app, used for grouping and easier viewing in
   * the UI.
   */
  appName: string;

  /**
   * The functions available at this particular handler.
   */
  functions: FunctionConfig[];

  /**
   * The hash of the current commit used to track deploys
   */
  hash?: string;
}

/**
 * The response to send to the local SDK UI when an introspection request is
 * made.
 *
 * @internal
 */
export interface IntrospectRequest {
  message: string;

  /**
   * Represents whether a signing key could be found when running this handler.
   */
  hasSigningKey: boolean;

  /**
   * Represents whether an event key could be found when running this handler.
   */
  hasEventKey: boolean;

  /**
   * The number of Inngest functions found at this handler.
   */
  functionsFound: number;
}

/**
 * An individual function trigger.
 *
 * @internal
 */
export type FunctionTrigger<T = string> =
  | {
      event: T;
      expression?: string;
    }
  | {
      cron: string;
    };

/**
 * A block representing an individual function being registered to Inngest
 * Cloud.
 *
 * @internal
 */
export interface FunctionConfig {
  name?: string;
  id: string;
  triggers: FunctionTrigger[];
  steps: Record<
    string,
    {
      id: string;
      name: string;
      runtime: {
        type: "http";
        url: string;
      };
      retries?: {
        attempts?: number;
      };
    }
  >;
  idempotency?: string;
  batchEvents?: {
    maxSize: number;
    timeout: string;
  };
  throttle?: {
    key?: string;
    count: number;
    period: TimeStr;
  };
  cancel?: {
    event: string;
    if?: string;
    timeout?: string;
  }[];
}

export interface DevServerInfo {
  /**
   * The version of the dev server.
   */
  version: string;
  authed: boolean;
  startOpts: {
    dir?: string;
    autodiscover: boolean;
    urls: string[];
  };
  functions: FunctionConfig[];
  handlers: RegisterRequest[];
}

/**
 * Given a set of events and a user-friendly trigger paramter, returns the name
 * of the event that the user intends to listen to.
 *
 * @public
 */
export type EventNameFromTrigger<
  Events extends Record<string, EventPayload>,
  T extends TriggerOptions<keyof Events & string>,
> = T extends string ? T : T extends { event: string } ? T["event"] : string;

/**
 * A union to represent known names of supported frameworks that we can use
 * internally to assess functionality based on a mix of framework and platform.
 */
export type SupportedFrameworkName =
  | "cloudflare-pages"
  | "digitalocean"
  | "edge"
  | "express"
  | "aws-lambda"
  | "nextjs"
  | "nuxt"
  | "h3"
  | "redwoodjs"
  | "remix"
  | "deno/fresh"
  | "sveltekit"
  | "fastify"
  | "koa";

/**
 * A set of options that can be passed to any step to configure it.
 *
 * @public
 */
export interface StepOptions {
  /**
   * The ID to use to memoize the result of this step, ensuring it is run only
   * once. Changing this ID in an existing function will cause the step to be
   * run again for in-progress runs; it is recommended to use a stable ID.
   */
  id: string;

  /**
   * The display name to use for this step in the Inngest UI. This can be
   * changed at any time without affecting the step's behaviour.
   */
  name?: string;
}

/**
 * Either a step ID or a set of step options.
 *
 * @public
 */
export type StepOptionsOrId = StepOptions["id"] | StepOptions;

export type EventsFromFunction<T extends AnyInngestFunction> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends InngestFunction<any, infer TEvents, any, any, any>
    ? TEvents
    : never;

export type TriggerEventFromFunction<
  TFunction extends AnyInngestFunction | string,
  TEvents = TFunction extends AnyInngestFunction
    ? EventsFromFunction<TFunction>
    : never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
> = TFunction extends InngestFunction<any, any, infer ITrigger, any, any>
  ? ITrigger extends {
      event: infer IEventTrigger extends keyof TEvents & string;
    }
    ? Simplify<Omit<TEvents[IEventTrigger], "name" | "ts">>
    : ITrigger extends { cron: string }
      ? never
      : never
  : TFunction extends string
    ? Simplify<Omit<EventPayload, "name" | "ts">>
    : never;

export type InvocationResult<TReturn> = Promise<TReturn>;
// TODO Types ready for when we expand this.
// & {
//   result: InvocationResult<TReturn>;
//   cancel: (reason: string) => Promise<void>; // TODO Need to be a Promise? 🤔
//   queued: Promise<{ runId: string }>;
// };

/**
 * Simplified version of Rust style `Result`
 *
 * Make it easier to wrap functions with some kind of result.
 * e.g. API calls
 */
export type Result<T, E = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: E | undefined };

export const ok = <T>(data: T): Result<T, never> => {
  return { ok: true, value: data };
};

export const err = <E>(error?: E): Result<never, E> => {
  return { ok: false, error };
};
