import { z } from "zod";
import { type EventSchemas } from "./components/EventSchemas";
import { type EventsFromOpts, type Inngest } from "./components/Inngest";
import {
  type InngestMiddleware,
  type MiddlewareOptions,
} from "./components/InngestMiddleware";
import { type createStepTools } from "./components/InngestStepTools";
import { type internalEvents } from "./helpers/consts";
import {
  type IsStringLiteral,
  type KeysNotOfType,
  type ObjectPaths,
  type StrictUnion,
} from "./helpers/types";
import { type Logger } from "./middleware/logger";

/**
 * TODO
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GetEvents<T extends Inngest<any>> = T extends Inngest<infer U>
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
  ...InngestMiddleware<MiddlewareOptions>[]
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

/**
 * Unique codes for the different types of operation that can be sent to Inngest
 * from SDK step functions.
 */
export enum StepOpCode {
  WaitForEvent = "WaitForEvent",
  RunStep = "Step",
  StepPlanned = "StepPlanned",
  Sleep = "Sleep",
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
   * The unhashed step name for this operation.
   */
  name: string;

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
  "id" | "op" | "name" | "opts" | "data" | "error"
>;

/**
 * The shape of a hashed operation in a step function. Used to communicate
 * desired and received operations to Inngest.
 */
export type HashedOp = Op & {
  /**
   * The hashed identifier for this operation, used to confirm that the operation
   * was completed when it is received from Inngest.
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

export type BaseContext<
  TOpts extends ClientOptions,
  TTrigger extends keyof EventsFromOpts<TOpts> & string,
  TShimmedFns extends Record<string, (...args: unknown[]) => unknown>
> = {
  /**
   * The event data present in the payload.
   */
  event: EventsFromOpts<TOpts>[TTrigger];

  events: EventsFromOpts<TOpts>[TTrigger][];

  /**
   * The run ID for the current function execution
   */
  runId: string;

  step: ReturnType<
    typeof createStepTools<TOpts, EventsFromOpts<TOpts>, TTrigger>
  >;

  /**
   * Any `fns` passed when creating your Inngest function will be
   * available here and can be used as normal.
   *
   * Every call to one of these functions will become a new retryable
   * step.
   *
   * @example
   *
   * Both examples behave the same; it's preference as to which you
   * prefer.
   *
   * ```ts
   * import { userDb } from "./db";
   *
   * // Specify `fns` and be able to use them in your Inngest function
   * inngest.createFunction(
   *   { name: "Create user from PR", fns: { ...userDb } },
   *   { event: "github/pull_request" },
   *   async ({ tools: { run }, fns: { createUser } }) => {
   *     await createUser("Alice");
   *   }
   * );
   *
   * // Or always use `run()` to run inline steps and use them directly
   * inngest.createFunction(
   *   { name: "Create user from PR" },
   *   { event: "github/pull_request" },
   *   async ({ tools: { run } }) => {
   *     await run("createUser", () => userDb.createUser("Alice"));
   *   }
   * );
   * ```
   */
  fns: TShimmedFns;
};

/**
 * Given a set of generic objects, extract any top-level functions and
 * appropriately shim their types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ShimmedFns<Fns extends Record<string, any>> = {
  /**
   * The key omission here allows the user to pass anything to the `fns`
   * object and have it be correctly understand and transformed.
   *
   * Crucially, we use a complex `Omit` here to ensure that function
   * comments and metadata is preserved, meaning the user can still use
   * the function exactly like they would in the rest of their codebase,
   * even though we're shimming with `tools.run()`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof Omit<Fns, KeysNotOfType<Fns, (...args: any[]) => any>>]: (
    ...args: Parameters<Fns[K]>
  ) => Promise<Awaited<ReturnType<Fns[K]>>>;
};

/**
 * Builds a context object for an Inngest handler, optionally overriding some
 * keys.
 */
export type Context<
  TOpts extends ClientOptions,
  TEvents extends Record<string, EventPayload>,
  TTrigger extends keyof TEvents & string,
  TShimmedFns extends Record<string, (...args: unknown[]) => unknown>,
  TOverrides extends Record<string, unknown> = Record<never, never>
> = Omit<BaseContext<TOpts, TTrigger, TShimmedFns>, keyof TOverrides> &
  TOverrides;

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
  TShimmedFns extends Record<string, (...args: unknown[]) => unknown> = Record<
    never,
    never
  >,
  TOverrides extends Record<string, unknown> = Record<never, never>
> = (
  /**
   * The context argument provides access to all data and tooling available to
   * the function.
   */
  ctx: Context<TOpts, TEvents, TTrigger, TShimmedFns, TOverrides>
) => unknown;

/**
 * The shape of a single event's payload. It should be extended to enforce
 * adherence to given events and not used as a method of creating them (i.e. as
 * a generic).
 *
 * @public
 */
export interface EventPayload {
  /**
   * A unique identifier for the event
   */
  name: string;

  /**
   * Any data pertinent to the event
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;

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
   * The name of this instance, most commonly the name of the application it
   * resides in.
   */
  name: string;

  /**
   * Inngest event key, used to send events to Inngest Cloud. If not provided,
   * will search for the `INNGEST_EVENT_KEY` environment variable. If neither
   * can be found, however, a warning will be shown and any attempts to send
   * events will throw an error.
   */
  eventKey?: string;

  /**
   * The base Inngest Source API URL to append the Source API Key to.
   * Defaults to https://inn.gs/
   */
  inngestBaseUrl?: string;

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
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "silent";

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
  inngestRegisterUrl?: string;

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
   * Controls whether a landing page with introspection capabilities is shown
   * when a `GET` request is performed to this handler.
   *
   * Defaults to using the boolean value of `process.env.INNGEST_LANDING_PAGE`
   * (e.g. `"true"`), and `true` if that env var is not defined.
   *
   * This page is highly recommended when getting started in development,
   * testing, or staging environments.
   */
  landingPage?: boolean;

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
   * The name of this app as it will be seen in the Inngest dashboard. Will use
   * the name of the client passed if not provided.
   */
  name?: string;
}

/**
 * A user-friendly method of specifying a trigger for an Inngest function.
 */
export type TriggerOptions<T extends string> =
  | T
  | StrictUnion<
      | {
          event: T;
        }
      | {
          cron: string;
        }
    >;

/**
 * A set of options for configuring an Inngest function.
 *
 * @public
 */
export interface FunctionOptions<
  Events extends Record<string, EventPayload>,
  Event extends keyof Events & string
> {
  /**
   * An optional unique ID used to identify the function. This is used
   * internally for versioning and referring to your function, so should not
   * change between deployments.
   *
   * By default, this is a slugified version of the given `name`, e.g.
   * `"My FN :)"` would be slugified to `"my-fn"`.
   *
   * If you are not specifying an ID and get a warning about duplicate
   * functions, make sure to explicitly set an ID for the duplicate or change
   * the name.
   */
  id?: string;

  /**
   * A name for the function as it will appear in the Inngest Cloud UI.
   *
   * This is used to create a slugified ID for the function too, e.g.
   * `"My FN :)"` would create a slugified ID of `"my-fn"`.
   *
   * If you are not specifying an ID and get a warning about duplicate
   * functions, make sure to explicitly set an ID for the duplicate or change
   * the name.
   */
  name: string;

  /**
   * Concurrency specifies a limit on the total number of concurrent steps that
   * can occur across all runs of the function.  A value of 0 (or undefined) means
   * use the maximum available concurrency.
   *
   * Specifying just a number means specifying only the concurrency limit.
   */
  concurrency?: number | { limit: number };

  /**
   * batchEvents specifies the batch configuration on when this function
   * should be invoked when one of the requirements are fulfilled.
   *
   * @example { maxSize: 100, timeout: "1s" }
   */
  batchEvents?: {
    /**
     * The maximum number of events to be consumed in one batch
     */
    maxSize: number;

    /**
     * How long to wait before invoking the function with a list of events.
     * If timeout is reached, the function will be invoked with a batch
     * even if it's not filled up to `maxSize`.
     */
    timeout: string;
  };

  fns?: Record<string, unknown>;

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
   * TODO
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
  TriggeringEvent extends keyof Events & string
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
 * Expected responses to be used within an `InngestCommHandler` in order to
 * appropriately respond to Inngest.
 *
 * @internal
 */
export type StepRunResponse =
  | {
      status: 500;
      error?: unknown;
    }
  | {
      status: 200;
      body?: unknown;
    }
  | {
      status: 206;
      body: OutgoingOp[];
    }
  | {
      status: 400;
      error: string;
    };

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
export interface IntrospectRequest extends RegisterRequest {
  /**
   * Represents whether a signing key could be found when running this handler.
   */
  hasSigningKey: boolean;

  /**
   * devserverURL must be included for the frontend to know where to ping.
   */
  devServerURL: string;
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
  name: string;
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
  T extends TriggerOptions<keyof Events & string>
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
  | "redwoodjs"
  | "remix"
  | "deno/fresh";

/**
 * A set of options that can be passed to any step to configure it.
 */
export interface StepOpts {
  /**
   * Passing an `id` for a step will overwrite the generated hash that is used
   * by Inngest to pause and resume a function.
   *
   * This is useful if you want to ensure that a step is always the same ID even
   * if the code changes.
   *
   * We recommend not using this unless you have a specific reason to do so.
   */
  id?: string;
}
