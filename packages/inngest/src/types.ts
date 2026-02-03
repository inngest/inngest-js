/**
 * Internal types and schemas used throughout the Inngest SDK.
 *
 * Note that types intended to be imported and utilized in userland code will be
 * exported from the main entrypoint of the SDK, `inngest`; importing types
 * directly from this file may result in breaking changes in non-major bumps as
 * only those exported from `inngest` are considered stable.
 *
 * @module
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod/v3";
import type { builtInMiddleware, Inngest } from "./components/Inngest.ts";
import type { InngestEndpointAdapter } from "./components/InngestEndpointAdapter.ts";
import type { InngestFunction } from "./components/InngestFunction.ts";
import type { InngestFunctionReference } from "./components/InngestFunctionReference.ts";
import type {
  ExtendSendEventWithMiddleware,
  InngestMiddleware,
} from "./components/InngestMiddleware.ts";
import type { createStepTools } from "./components/InngestStepTools.ts";
import type {
  EventType,
  EventTypeWithAnySchema,
} from "./components/triggers/triggers.ts";
import type { internalEvents } from "./helpers/consts.ts";
import type { GoInterval } from "./helpers/promises.ts";
import type * as Temporal from "./helpers/temporal.ts";
import type {
  AsTuple,
  IsEqual,
  IsNever,
  Public,
  Simplify,
} from "./helpers/types.ts";
import type { Logger } from "./middleware/logger.ts";

export type { Jsonify } from "./helpers/jsonify.ts";
export type { SimplifyDeep } from "./helpers/types.ts";

const baseJsonErrorSchema = z.object({
  name: z.string().trim().optional(),
  error: z.string().trim().optional(),
  message: z.string().trim().optional(),
  stack: z.string().trim().optional(),
});

const maybeJsonErrorSchema: z.ZodType<{
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}> = z.lazy(() =>
  z.object({
    name: z.string().trim(),
    message: z.string().trim(),
    stack: z.string().trim().optional(),
    cause: z.union([maybeJsonErrorSchema, z.unknown()]).optional(),
  }),
);

export type JsonError = z.infer<typeof baseJsonErrorSchema> & {
  name: string;
  message: string;
  cause?: unknown;
};

export const jsonErrorSchema = baseJsonErrorSchema
  .extend({
    cause: z.union([maybeJsonErrorSchema, z.unknown()]).optional(),
  })
  .passthrough()
  .catch({})
  .transform((val) => {
    return {
      ...val,
      name: val.name || "Error",
      message: val.message || val.error || "Unknown error",
      stack: val.stack,
    };
  }) as z.ZodType<JsonError>;

/**
 * The payload for an API endpoint running steps.
 */
export type APIStepPayload = {
  name: `${internalEvents.HttpRequest}`;
  data: {
    /**
     * The domain that served the original request.
     */
    domain: string;

    /**
     * The method used to trigger the original request.
     */
    method: string;

    /**
     * The URL path of the original request.
     */
    path: string;

    /**
     * The IP that made the original request, fetched from headers.
     */
    ip: string;

    /**
     * The "Content-Type" header of the original request.
     */
    content_type: string;

    /**
     * The query parameters of the original request, as a single string without
     * the leading `"?"`.
     */
    query_params: string;

    /**
     * The body of the original request.
     */
    body?: string;

    /**
     * An optional function ID to use for this endpoint. If not provided,
     * Inngest will generate a function ID based on the method and path, e.g.
     * `"GET /api/hello"`.
     */
    fn?: string; // maybe explicit fn ID from user, else empty
  };
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
    error: z.output<typeof jsonErrorSchema>;
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
 * The payload for an internal Inngest event that is sent when a function
 * finishes, either by completing successfully or failing.
 *
 * @public
 */
export type FinishedEventPayload = {
  name: `${internalEvents.FunctionFinished}`;
  data: {
    function_id: string;
    run_id: string;
    correlation_id?: string;
  } & (
    | {
        error: z.output<typeof jsonErrorSchema>;
      }
    | {
        result: unknown;
      }
  );
};

/**
 * The payload for an internal Inngest event that is sent when a function is
 * cancelled.
 */
export type CancelledEventPayload = {
  name: `${internalEvents.FunctionCancelled}`;
  data: {
    function_id: string;
    run_id: string;
    correlation_id?: string;
  };
};

/**
 * The payload for any generic function invocation event. In practice, the event
 * data will be more specific to the function being invoked.
 *
 * @public
 */
export type InvokedEventPayload = Simplify<
  Omit<EventPayload, "name"> & {
    name: `${internalEvents.FunctionInvoked}`;
  }
>;

/**
 * The payload for the event sent to a function when it is triggered by a cron.
 *
 * @public
 */
export type ScheduledTimerEventPayload = Simplify<
  Omit<EventPayload, "name" | "data" | "id"> & {
    name: `${internalEvents.ScheduledTimer}`;
    data: {
      cron: string;
    };
    id: string;
  }
>;

/**
 * Unique codes for the different types of operation that can be sent to Inngest
 * from SDK step functions.
 */
export enum StepOpCode {
  WaitForSignal = "WaitForSignal",

  WaitForEvent = "WaitForEvent",

  /**
   * Legacy equivalent to `"StepRun"`. Has mixed data wrapping (e.g. `data` or
   * `data.data` depending on SDK version), so this is phased out in favour of
   * `"StepRun"`, which never wraps.
   *
   * Note that it is still used for v0 executions for backwards compatibility.
   *
   * @deprecated Only used for v0 executions; use `"StepRun"` instead.
   */
  Step = "Step",
  StepRun = "StepRun",
  StepError = "StepError",
  StepFailed = "StepFailed",
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
  AiGateway = "AIGateway",
  Gateway = "Gateway",

  RunComplete = "RunComplete",
  DiscoveryRequest = "DiscoveryRequest",
}

/**
 * StepModes are used to specify how the SDK should execute a function.
 */
export enum StepMode {
  /**
   * A synchronous method of execution, where steps are executed immediately and
   * their results are "checkpointed" back to Inngest in real-time.
   */
  Sync = "sync",

  /**
   * The traditional, background method of execution, where all steps are queued
   * and executed asynchronously and always triggered by Inngest.
   */
  Async = "async",

  /**
   * The traditional, background method of execution, but step results are
   * checkpointed when they can be to reduce latency and the number of requests
   * being sent back and forth between Inngest and the SDK.
   */
  AsyncCheckpointing = "async_checkpointing",
}

/**
 * The type of response you wish to return to an API endpoint when using steps
 * within it and we must transition to {@link StepMode.Async}.
 *
 * In most cases, this defaults to {@link AsyncResponseType.Redirect}.
 */
export enum AsyncResponseType {
  /**
   * When switching to {@link StepMode.Async}, respond with a 302 redirect which
   * will end the request once the run has completed asynchronously in the
   * background.
   */
  Redirect = "redirect",

  /**
   * When switching to {@link StepMode.Async}, respond with a token and run ID
   * which can be used to poll for the status of the run.
   */
  Token = "token",

  /**
   * TODO Comment
   */
  // Custom = "custom",
}

/**
 * The type of response you wish to return to an API endpoint when using steps
 * within it and we must transition to {@link StepMode.Async}.
 *
 * In most cases, this defaults to {@link AsyncResponseType.Redirect}.
 */
export type AsyncResponseValue =
  | AsyncResponseType.Redirect
  | AsyncResponseType.Token;
// | (() => null);

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
   * What {@link StepMode} this step supports. If a step is marked as supporting
   * {@link StepMode.Async} we must be in (or switch to) async mode in order to
   * execute it.
   */
  mode: StepMode;

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

  /**
   * Extra info used to annotate spans associated with this operation.
   */
  userland: OpUserland;

  /**
   * Golang-compatibile `interval.Interval` timing information for this operation.
   */
  timing?: GoInterval;
};

/**
 * Extra info attached to an operation.
 */
export type OpUserland = {
  /**
   * The unhashed, user-defined ID of the step.
   */
  id: string;
  /**
   * The auto-incremented index for repeated steps (if repeated).
   */
  index?: number;
};

export const incomingOpSchema = z.object({
  id: z.string().min(1),
  data: z.any().optional(),
  error: z.any().optional(),
  input: z.any().optional(),
});

export type IncomingOp = z.output<typeof incomingOpSchema>;

/**
 * The shape of a step operation that is sent to an Inngest Server from an SDK.
 *
 * @public
 */
export type OutgoingOp = Pick<
  Omit<HashedOp, "userland"> & { userland?: OpUserland },
  | "id"
  | "op"
  | "name"
  | "opts"
  | "data"
  | "error"
  | "displayName"
  | "userland"
  | "timing"
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

/**
 * Base context object, omitting any extras that may be added by middleware or
 * function configuration.
 *
 * @public
 */
export type BaseContext<TClient extends Inngest.Any> = {
  /**
   * The event data present in the payload.
   */
  event: Simplify<EventPayload>;
  events: AsTuple<Simplify<EventPayload>>;

  /**
   * The run ID for the current function execution
   */
  runId: string;

  step: ReturnType<typeof createStepTools<TClient>>;

  /**
   * The current zero-indexed attempt number for this function execution. The
   * first attempt will be `0`, the second `1`, and so on. The attempt number
   * is incremented every time the function throws an error and is retried.
   */
  attempt: number;

  /**
   * The maximum number of attempts allowed for this function.
   */
  maxAttempts?: number;
};

/**
 * Builds a context object for an Inngest handler, optionally overriding some
 * keys.
 *
 * @internal
 */
export type Context<
  TClient extends Inngest.Any = Inngest.Any,
  TOverrides extends Record<string, unknown> = Record<never, never>,
> = Omit<BaseContext<TClient>, keyof TOverrides> & TOverrides;

/**
 * Builds a context object for an Inngest handler, optionally overriding some
 * keys.
 *
 * @internal
 */
export namespace Context {
  /**
   * Represents any `Context` object, regardless of generics and inference.
   */
  export type Any = Context;
}

/**
 * The shape of a Inngest function, taking in event, step, ctx, and step
 * tooling.
 *
 * @public
 */
export type Handler<
  TClient extends Inngest.Any,
  TOverrides extends Record<string, unknown> = Record<never, never>,
> = (
  /**
   * The context argument provides access to all data and tooling available to
   * the function.
   */
  ctx: Context<TClient, TOverrides>,
) => unknown;

/**
 * The shape of a Inngest function, taking in event, step, ctx, and step
 * tooling.
 *
 * @public
 */
export namespace Handler {
  /**
   * Represents any `Handler`, regardless of generics and inference.
   */
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  export type Any = Handler<Inngest.Any, any>;
}

/**
 * The shape of a single event's payload without any fields used to identify the
 * actual event being sent.
 *
 * This is used to represent an event payload when invoking a function, as the
 * event name is not known or needed.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional
export interface MinimalEventPayload<TData = any> {
  /**
   * A unique id used to idempotently process a given event payload.
   *
   * Set this when sending events to ensure that the event is only processed
   * once; if an event with the same ID is sent again, it will not invoke
   * functions.
   */
  id?: string;

  /**
   * Any data pertinent to the event
   */
  data?: TData;

  /**
   * A specific event schema version
   * (optional)
   */
  v?: string;
}

/**
 * The shape of a single event's payload. It should be extended to enforce
 * adherence to given events and not used as a method of creating them (i.e. as
 * a generic).
 *
 * @public
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional
export interface EventPayload<TData = any> extends MinimalEventPayload<TData> {
  /**
   * A unique identifier for the type of event. We recommend using lowercase dot
   * notation for names, prepending `prefixes/` with a slash for organization.
   *
   * e.g. `cloudwatch/alarms/triggered`, `cart/session.created`
   */
  name: string;

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
  ids: z.array(z.string()).default([]),

  /**
   * HTTP Status Code. Will be undefined if no request was sent.
   */
  status: z.number().default(0),

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
 *
 * @public
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
  context: TContext,
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
   *
   * If you wish to specify your own fetch, make sure that you preserve its
   * binding, either by using `.bind` or by wrapping it in an anonymous
   * function.
   */
  fetch?: typeof fetch;

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
  middleware?: InngestMiddleware.Stack;

  /**
   * Can be used to explicitly set the client to Development Mode, which will
   * turn off signature verification and default to using a local URL to access
   * a local Dev Server.
   *
   * This is useful for forcing the client to use a local Dev Server while also
   * running in a production-like environment.
   */
  isDev?: boolean;

  /**
   * The application-specific version identifier. This can be an arbitrary value
   * such as a version string, a Git commit SHA, or any other unique identifier.
   */
  appVersion?: string;

  /**
   * If `true`, parallel steps within functions are optimized to reduce traffic
   * during `Promise` resolution, which can hugely reduce the time taken and
   * number of requests for each run.
   *
   * Note that this will be the default behaviour in v4 and in its current form
   * will cause `Promise.*()` to wait for all promises to settle before
   * resolving.
   *
   * @default false
   */
  optimizeParallelism?: boolean;

  /**
   * Whether or not to use checkpointing by default for executions of functions
   * created using this client.
   *
   * If `true`, enables checkpointing with default settings, which is a safe,
   * blocking version of checkpointing, where we check in with Inngest after
   * every step is run.
   *
   * If an object, you can tweak the settings to batch, set a maximum runtime
   * before going async, and more. Note that if your server dies before the
   * checkpoint completes, step data will be lost and steps will be rerun.
   *
   * We recommend starting with the default `true` configuration and only tweak
   * the parameters directly if necessary.
   *
   * @deprecated Use `checkpointing` instead.
   */
  experimentalCheckpointing?: CheckpointingOptions;

  /**
   * Whether or not to use checkpointing by default for executions of functions
   * created using this client.
   *
   * If `true`, enables checkpointing with default settings, which is a safe,
   * blocking version of checkpointing, where we check in with Inngest after
   * every step is run.
   *
   * If an object, you can tweak the settings to batch, set a maximum runtime
   * before going async, and more. Note that if your server dies before the
   * checkpoint completes, step data will be lost and steps will be rerun.
   *
   * We recommend starting with the default `true` configuration and only tweak
   * the parameters directly if necessary.
   */
  checkpointing?: CheckpointingOptions;

  /**
   * The signing key used to authenticate requests from Inngest.
   * If not provided, will search for the `INNGEST_SIGNING_KEY` environment variable.
   */
  signingKey?: string;

  /**
   * A fallback signing key used to authenticate requests from Inngest during key rotation.
   * If not provided, will search for the `INNGEST_SIGNING_KEY_FALLBACK` environment variable.
   */
  signingKeyFallback?: string;

  /**
   * The minimum log level to output from the Inngest library.
   * If not provided, will search for the `INNGEST_LOG_LEVEL` environment variable,
   * defaulting to "info".
   */
  logLevel?: LogLevel;

  /**
   * An optional endpoint adapter to use when creating Durable Endpoints using
   * `inngest.endpoint()`.
   */
  endpointAdapter?: InngestEndpointAdapter.Like;
}

export type CheckpointingOptions =
  | boolean
  | {
      /**
       * The maximum amount of time the function should be allowed to checkpoint
       * before falling back to async execution.
       *
       * We recommend setting this to a value slightly lower than your
       * platform's request timeout to ensure that functions can complete
       * checkpointing before being forcefully terminated.
       *
       * Set to `0` to disable maximum runtime.
       *
       * @default 0
       */
      maxRuntime?: number | string | Temporal.DurationLike;

      /**
       * The number of steps to buffer together before checkpointing. This can
       * help reduce the number of requests made to Inngest when running many
       * steps in sequence.
       *
       * Set to `1` to checkpoint after every step.
       *
       * @default 1
       */
      bufferedSteps?: number;

      /**
       * The maximum interval to wait before checkpointing, even if the buffered
       * step count has not been reached.
       */
      maxInterval?: number | string | Temporal.DurationLike;
    };

/**
 * Internal version of {@link CheckpointingOptions} with the `true` option
 * excluded, as that just suggests using the default options.
 */
export type InternalCheckpointingOptions = Exclude<
  Required<CheckpointingOptions>,
  boolean
>;

/**
 * Default config options if `true` has been passed by a user.
 */
export const defaultCheckpointingOptions: InternalCheckpointingOptions = {
  bufferedSteps: 1,
  maxRuntime: 0,
  maxInterval: 0,
};

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
   * To also provide a custom hostname, use `serveOrigin`.
   */
  servePath?: string;

  /**
   * The origin used to access the Inngest serve endpoint, e.g.:
   *
   *     "https://myapp.com" or "https://myapp.com:1234"
   *
   * By default, the library will try to infer this using request details such
   * as the "Host" header and request path, but sometimes this isn't possible
   * (e.g. when running in a more controlled environments such as AWS Lambda or
   * when dealing with proxies/redirects).
   *
   * Provide the custom origin here to ensure that the path is reported
   * correctly when registering functions with Inngest.
   *
   * To also provide a custom path, use `servePath`.
   */
  serveOrigin?: string;

  /**
   * Some serverless providers (especially those with edge compute) may support
   * streaming responses back to Inngest. This can be used to circumvent
   * restrictive request timeouts and other limitations. It is only available if
   * the serve handler being used supports streaming.
   *
   * If this is `"true"`, the SDK will attempt to stream responses back
   * to Inngest. If the serve handler does not support streaming, an error will be thrown.
   *
   * If this is `false`, streaming will never be used.
   *
   * Defaults to `false`.
   */
  streaming?: true | false;
}

/**
 * This schema is used internally to share the shape of a concurrency option
 * when validating config. We cannot add comments to Zod fields, so we just use
 * an extra type check to ensure it matches our exported expectations.
 */
const concurrencyOptionSchema = z.strictObject({
  limit: z.number(),
  key: z.string().optional(),
  scope: z.enum(["fn", "env", "account"]).optional(),
});

const _checkConcurrencySchemaAligns: IsEqual<
  ConcurrencyOption,
  z.output<typeof concurrencyOptionSchema>
> = true;

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
 * Configuration for cancelling a function run based on an incoming event.
 *
 * @public
 */
export type Cancellation = {
  /**
   * The name of the event that should cancel the function run.
   */
  event: string | EventTypeWithAnySchema<string>;

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
   *
   * @deprecated Use `if` instead.
   */
  match?: string;

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
   * AppVersion represents an optional application version identifier. This should change
   * whenever code within one of your Inngest function or any dependency thereof changes.
   */
  appVersion?: string;

  /**
   * The functions available at this particular handler.
   */
  functions: FunctionConfig[];

  /**
   * The deploy ID used to identify this particular deployment.
   */
  deployId?: string;

  /**
   * Capabilities of the SDK.
   */
  capabilities: Capabilities;
}

export interface Capabilities {
  trust_probe: "v1";
  connect: "v1";
}

export interface InBandRegisterRequest
  extends Pick<
      RegisterRequest,
      "capabilities" | "framework" | "functions" | "sdk" | "url" | "appVersion"
    >,
    Pick<AuthenticatedIntrospection, "sdk_language" | "sdk_version" | "env"> {
  /**
   * The ID of the app that this handler is associated with.
   */
  app_id: string;

  /**
   * The result of the introspection request.
   */
  inspection: AuthenticatedIntrospection | UnauthenticatedIntrospection;

  /**
   * ?
   */
  platform?: string;

  /**
   * The person or organization that authored this SDK. Ideally this is
   * synonymous with a GitHub username or organization name.
   */
  sdk_author: "inngest";
}

/**
 * The response to send to the local SDK UI when an introspection request is
 * made.
 *
 * @internal
 */
export interface UnauthenticatedIntrospection {
  extra: {
    native_crypto: boolean;
  };
  function_count: number;
  has_event_key: boolean;
  has_signing_key: boolean;
  mode: "cloud" | "dev";
  schema_version: "2024-05-24";
}

export interface AuthenticatedIntrospection
  extends Omit<
    UnauthenticatedIntrospection,
    "authentication_succeeded" | "extra"
  > {
  api_origin: string;
  app_id: string;
  authentication_succeeded: true;
  capabilities: Capabilities;
  env: string | null;
  event_api_origin: string;
  event_key_hash: string | null;
  extra: {
    is_streaming: boolean;
    native_crypto: boolean;
  };
  framework: string;
  sdk_language: string;
  sdk_version: string;
  serve_origin: string | null;
  serve_path: string | null;
  signing_key_fallback_hash: string | null;
  signing_key_hash: string | null;
}

/**
 * The schema used to represent an individual function being synced with
 * Inngest.
 *
 * Note that this should only be used to validate the shape of a config object
 * and not used for feature compatibility, such as feature X being exclusive
 * with feature Y; these should be handled on the Inngest side.
 */
export const functionConfigSchema = z.strictObject({
  name: z.string().optional(),
  id: z.string(),
  triggers: z.array(
    z.union([
      z.strictObject({
        event: z.string(),
        expression: z.string().optional(),
      }),
      z.strictObject({
        cron: z.string(),
      }),
    ]),
  ),
  steps: z.record(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      runtime: z.strictObject({
        type: z.union([z.literal("http"), z.literal("ws")]),
        url: z.string(),
      }),
      retries: z
        .strictObject({
          attempts: z.number().optional(),
        })
        .optional(),
    }),
  ),
  idempotency: z.string().optional(),
  batchEvents: z
    .strictObject({
      maxSize: z.number(),
      timeout: z.string(),
      key: z.string().optional(),
      if: z.string().optional(),
    })
    .optional(),
  rateLimit: z
    .strictObject({
      key: z.string().optional(),
      limit: z.number(),
      period: z.string().transform((x) => x as TimeStr),
    })
    .optional(),
  throttle: z
    .strictObject({
      key: z.string().optional(),
      limit: z.number(),
      period: z.string().transform((x) => x as TimeStr),
      burst: z.number().optional(),
    })
    .optional(),
  singleton: z
    .strictObject({
      key: z.string().optional(),
      mode: z.enum(["skip", "cancel"]),
    })
    .optional(),
  cancel: z
    .array(
      z.strictObject({
        event: z.string(),
        if: z.string().optional(),
        timeout: z.string().optional(),
      }),
    )
    .optional(),
  debounce: z
    .strictObject({
      key: z.string().optional(),
      period: z.string().transform((x) => x as TimeStr),
      timeout: z
        .string()
        .transform((x) => x as TimeStr)
        .optional(),
    })
    .optional(),
  timeouts: z
    .strictObject({
      start: z
        .string()
        .transform((x) => x as TimeStr)
        .optional(),
      finish: z
        .string()
        .transform((x) => x as TimeStr)
        .optional(),
    })
    .optional(),
  priority: z
    .strictObject({
      run: z.string().optional(),
    })
    .optional(),
  concurrency: z
    .union([
      z.number(),
      concurrencyOptionSchema.transform((x) => x as ConcurrencyOption),
      z
        .array(concurrencyOptionSchema.transform((x) => x as ConcurrencyOption))
        .min(1)
        .max(2),
    ])
    .optional(),
});

/**
 * The shape of an individual function being synced with Inngest.
 *
 * @internal
 */
export type FunctionConfig = z.output<typeof functionConfigSchema>;

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
 * Given a user-friendly trigger parameter, returns the name of the event that
 * the user intends to listen to.
 *
 * @public
 */
export type EventNameFromTrigger<T extends InngestFunction.Trigger<string>> =
  IsNever<T> extends true // `never` indicates there are no triggers, so the payload could be anything
    ? `${internalEvents.FunctionInvoked}`
    : T extends string // `string` indicates a migration from v2 to v3
      ? T
      : // If the trigger is an event string (e.g. `{ event: "my-event" }`)
        T extends { event: infer IEvent } // an event trigger
        ? // If the event is an EventType (e.g. `{ event: eventType("my-event") }`)
          IEvent extends EventType<infer TName, infer _TSchema>
          ? TName // Extract name from EventType
          : IEvent // Use event directly if it's a string
        : T extends { cron: string } // a cron trigger
          ? `${internalEvents.ScheduledTimer}`
          : never;

/**
 * A union to represent known names of supported frameworks that we can use
 * internally to assess functionality based on a mix of framework and platform.
 */
export type SupportedFrameworkName =
  | "astro"
  | "bun"
  | "cloudflare-pages"
  | "digitalocean"
  | "edge"
  | "express"
  | "aws-lambda"
  | "nextjs"
  | "nodejs"
  | "nuxt"
  | "h3"
  | "redwoodjs"
  | "remix"
  | "deno/fresh"
  | "sveltekit"
  | "fastify"
  | "koa"
  | "hono"
  | "nitro";

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

/**
 * An object containing info to target a run/step/step attempt/span, used for attaching metadata.
 */
export type MetadataTarget =
  | {
      // run level
      run_id: string;
    }
  | {
      // step level
      run_id: string;
      step_id: string; // user-defined
      step_index?: number;
    }
  | {
      // step attempt level
      run_id: string;
      step_id: string; // user-defined
      step_index?: number;
      step_attempt: number; // -1 === last attempt?
    }
  | {
      // span level
      run_id: string;
      step_id: string; // user-defined
      step_index?: number;
      step_attempt: number; // -1 === last attempt?
      span_id: string;
    };

/**
 * A function that can be invoked by Inngest.
 */
export type InvokeTargetFunctionDefinition =
  | Public<InngestFunctionReference.Any>
  | Public<InngestFunction.Any>;

/**
 * Given an invocation target, extract the payload that will be used to trigger
 * it.
 *
 * If we could not find a payload, will return `never`.
 */
export type TriggerEventFromFunction<
  TFunction extends InvokeTargetFunctionDefinition,
> = TFunction extends InngestFunction.Any
  ? PayloadForAnyInngestFunction<TFunction>
  : TFunction extends InngestFunctionReference<
        infer IInput extends MinimalEventPayload,
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        any
      >
    ? IInput
    : MinimalEventPayload;

/**
 * Extracts the input type from invoke trigger schemas only.
 * For `step.invoke`, we need the schema INPUT type (what the caller provides),
 * not the output type (what the function receives after transformation).
 *
 * Only extracts from `invoke(schema)` triggers (event: "inngest/function.invoked").
 * Returns a union of all invoke trigger input types.
 *
 * @internal
 */
type ExtractInvokeSchemaInput<T extends readonly unknown[]> =
  T extends readonly [infer First, ...infer Rest]
    ? First extends {
        event: "inngest/function.invoked";
        schema: infer TSchema;
      }
      ? TSchema extends StandardSchemaV1<infer TData>
        ? TData | ExtractInvokeSchemaInput<Rest>
        : ExtractInvokeSchemaInput<Rest>
      : ExtractInvokeSchemaInput<Rest>
    : never;

/**
 * Extracts the input type from any trigger with a schema.
 * Used as a fallback when no invoke triggers exist.
 *
 * @internal
 */
type ExtractTriggerSchemaInput<T extends readonly unknown[]> =
  T extends readonly [infer First, ...infer Rest]
    ? First extends { schema: infer TSchema }
      ? TSchema extends StandardSchemaV1<infer TData>
        ? TData
        : ExtractTriggerSchemaInput<Rest>
      : ExtractTriggerSchemaInput<Rest>
    : never;

/**
 * Checks if a trigger array contains an invoke trigger with a schema.
 *
 * @internal
 */
type HasInvokeTriggerWithSchema<T extends readonly unknown[]> =
  T extends readonly [infer First, ...infer Rest]
    ? First extends {
        event: "inngest/function.invoked";
        // biome-ignore lint/suspicious/noExplicitAny: Need any to match any StandardSchemaV1
        schema: StandardSchemaV1<any>;
      }
      ? true
      : HasInvokeTriggerWithSchema<Rest>
    : false;

/**
 * Checks if a trigger array contains any trigger with a schema.
 *
 * @internal
 */
type HasTriggerWithSchema<T extends readonly unknown[]> = T extends readonly [
  infer First,
  ...infer Rest,
]
  ? First extends {
      // biome-ignore lint/suspicious/noExplicitAny: Need any to match any StandardSchemaV1
      schema: StandardSchemaV1<any>;
    }
    ? true
    : HasTriggerWithSchema<Rest>
  : false;

/**
 * Given an {@link InngestFunction} instance, extract the {@link MinimalPayload}
 * that will be used to trigger it.
 *
 * This is intended to see what **input** a developer is expected to give to
 * invoke a function; it should not be used for evaluating the payload received
 * inside an invoked function.
 *
 * If we could not find a payload or the function does not require a payload
 * (e.g. a cron), then will return `{}`, as this is intended to be used to
 * spread into other arguments.
 *
 * @internal
 */
export type PayloadForAnyInngestFunction<
  TFunction extends InngestFunction.Any,
> = TFunction extends InngestFunction<
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  any,
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  any,
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  any,
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  any,
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  any,
  infer ITriggers extends InngestFunction.Trigger<string>[]
>
  ? // First check: Does this function have an invoke trigger with a schema?
    // If so, only invoke schemas should be used (not eventType schemas)
    HasInvokeTriggerWithSchema<ITriggers> extends true
    ? { data: ExtractInvokeSchemaInput<ITriggers> }
    : // Second check: Does this function have any trigger with a schema?
      HasTriggerWithSchema<ITriggers> extends true
      ? // If so, use the schema's input type for the data property
        { data: ExtractTriggerSchemaInput<ITriggers> }
      : // Otherwise, fall back to existing behavior
        IsEqual<
            EventNameFromTrigger<ITriggers[number]>,
            `${internalEvents.ScheduledTimer}`
          > extends true
        ? object // If this is ONLY a cron trigger, then we don't need to provide a payload
        : MinimalEventPayload
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

export const inBandSyncRequestBodySchema = z.strictObject({
  url: z.string(),
});
