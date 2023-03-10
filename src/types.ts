import { z } from "zod";
import type { createStepTools } from "./components/InngestStepTools";
import { internalEvents } from "./helpers/consts";
import type { KeysNotOfType, ObjectPaths, StrictUnion } from "./helpers/types";

/**
 * Arguments for a single-step function.
 *
 * @public
 */
export type EventData<Event> = Event extends never
  ? Record<string, never>
  : "event" extends keyof Event
  ? {
      /**
       * The event data present in the payload.
       */
      event: Event["event"];
    }
  : {
      /**
       * The event data present in the payload.
       */
      event: Event;
    };

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
    error: {
      message: string;
      stack?: string;
      cause?: string;
      status?: number;
    };
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
  err: FailureEventPayload<P>["data"]["error"];
};

/**
 * Arguments for a multi-step function, extending the single-step args and
 * including step function tooling.
 *
 * @public
 */
export type HandlerArgs<
  Events extends Record<string, EventPayload>,
  Event extends keyof Events & string,
  Opts extends FunctionOptions<Events, Event>,
  Payload extends { event: any } = { event: Events[Event] }
> = Payload & {
  /**
   * @deprecated Use `step` instead.
   */
  tools: ReturnType<typeof createStepTools<Events, Event>>[0];

  step: ReturnType<typeof createStepTools<Events, Event>>[0];
} & (Opts["fns"] extends Record<string, any>
    ? {
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
        fns: {
          /**
           * The key omission here allows the user to pass anything to the `fns`
           * object and have it be correctly understand and transformed.
           *
           * Crucially, we use a complex `Omit` here to ensure that function
           * comments and metadata is preserved, meaning the user can still use
           * the function exactly like they would in the rest of their codebase,
           * even though we're shimming with `tools.run()`.
           */
          [K in keyof Omit<
            Opts["fns"],
            KeysNotOfType<Opts["fns"], (...args: any[]) => any>
          >]: (
            ...args: Parameters<Opts["fns"][K]>
          ) => Promise<Awaited<ReturnType<Opts["fns"][K]>>>;
        };
      }
    : Record<string, never>);

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
  opts?: any;

  /**
   * Any data present for this operation. If data is present, this operation is
   * treated as completed.
   */
  data?: any;

  /**
   * An error present for this operation. If an error is present, this operation
   * is treated as completed, but failed. When this is read from the op stack,
   * the SDK will throw the error via a promise rejection when it is read.
   *
   * This allows users to handle step failures using common tools such as
   * try/catch or `.catch()`.
   */
  error?: any;
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
  TEvents extends Record<string, EventPayload>,
  TTrigger extends keyof TEvents & string,
  TShimmedFns extends Record<string, (...args: any[]) => any>
> = {
  /**
   * The event data present in the payload.
   */
  event: TEvents[TTrigger];

  /**
   * @deprecated Use `step` instead.
   */
  tools: ReturnType<typeof createStepTools<TEvents, TTrigger>>[0];
  step: ReturnType<typeof createStepTools<TEvents, TTrigger>>[0];

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
export type ShimmedFns<Fns extends Record<string, any>> = Fns extends Record<
  string,
  any
>
  ? {
      /**
       * The key omission here allows the user to pass anything to the `fns`
       * object and have it be correctly understand and transformed.
       *
       * Crucially, we use a complex `Omit` here to ensure that function
       * comments and metadata is preserved, meaning the user can still use
       * the function exactly like they would in the rest of their codebase,
       * even though we're shimming with `tools.run()`.
       */
      [K in keyof Omit<Fns, KeysNotOfType<Fns, (...args: any[]) => any>>]: (
        ...args: Parameters<Fns[K]>
      ) => Promise<Awaited<ReturnType<Fns[K]>>>;
    }
  : Record<string, never>;

/**
 * Builds a context object for an Inngest handler, optionally overriding some
 * keys.
 */
export type Context<
  TEvents extends Record<string, EventPayload>,
  TTrigger extends keyof TEvents & string,
  TShimmedFns extends Record<string, (...args: any[]) => any>,
  TOverrides extends Record<string, any> = Record<never, never>
> = Omit<BaseContext<TEvents, TTrigger, TShimmedFns>, keyof TOverrides> &
  TOverrides;

/**
 * The shape of a Inngest function, taking in event, step, ctx, and step
 * tooling.
 *
 * @public
 */
export type Handler<
  TEvents extends Record<string, EventPayload>,
  TTrigger extends keyof TEvents & string,
  TShimmedFns extends Record<string, (...args: any[]) => any>,
  TOverrides extends Record<string, any> = Record<never, never>
> = (
  /**
   * The context argument provides access to all data and tooling available to
   * the function.
   */
  ctx: Context<TEvents, TTrigger, TShimmedFns, TOverrides>
) => any;

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
  data: any;

  /**
   * Any user data associated with the event
   * All fields ending in "_id" will be used to attribute the event to a particular user
   */
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
  body?: any;
}

/**
 * A single step within a function.
 *
 * @internal
 */
export type Step<Context = any> = (
  /**
   * The context for this step, including the triggering event and any previous
   * step output.
   */
  context: Context
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
   */
  concurrency?: number;

  fns?: Record<string, any>;

  /**
   * Allow the specification of an idempotency key using event data. If
   * specified, this overrides the throttle object.
   */
  idempotency?: string;

  /**
   * Throttle workflows, only running them a given number of times (count) per
   * period. This can optionally include a throttle key, which is used to
   * further constrain throttling similar to idempotency.
   */
  throttle?: {
    /**
     * An optional key to use for throttle, similar to idempotency.
     */
    key?: string;

    /**
     * The number of times to allow the function to run per the given `period`.
     */
    count: number;

    /**
     * The period of time to allow the function to run `count` times.
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

  onFailure?: (...args: any[]) => any;
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
  [K in keyof Events]: {
    /**
     * The name of the event that should cancel the function run.
     */
    event: K & string;

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
    match?: ObjectPaths<Events[TriggeringEvent]> & ObjectPaths<Events[K]>;

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
}[keyof Events];

/**
 * Expected responses to be used within an `InngestCommHandler` in order to
 * appropriately respond to Inngest.
 *
 * @internal
 */
export type StepRunResponse =
  | {
      status: 500;
      error?: string;
    }
  | {
      status: 200;
      body?: any;
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
  throttle?: {
    key?: string;
    count: number;
    period: TimeStr;
  };
  cancel?: {
    event: string;
    if?: string;
    timeout?: TimeStr;
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
