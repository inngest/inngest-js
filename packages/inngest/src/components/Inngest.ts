import { type IfNever, type Jsonify } from "type-fest";
import { type SimplifyDeep } from "type-fest/source/merge-deep";
import { InngestApi } from "../api/api";
import {
  defaultDevServerHost,
  defaultInngestApiBaseUrl,
  defaultInngestEventBaseUrl,
  dummyEventKey,
  envKeys,
  logPrefix,
} from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import {
  getFetch,
  getMode,
  inngestHeaders,
  processEnv,
  type Mode,
} from "../helpers/env";
import { fixEventKeyMissingSteps, prettyError } from "../helpers/errors";
import { stringify } from "../helpers/strings";
import {
  type ExclusiveKeys,
  type SendEventPayload,
  type WithoutInternal,
} from "../helpers/types";
import { DefaultLogger, ProxyLogger, type Logger } from "../middleware/logger";
import {
  sendEventResponseSchema,
  type ClientOptions,
  type EventNameFromTrigger,
  type EventPayload,
  type FailureEventArgs,
  type FunctionOptions,
  type FunctionTrigger,
  type Handler,
  type InvokeTargetFunctionDefinition,
  type MiddlewareStack,
  type SendEventOutput,
  type SendEventResponse,
  type TriggerOptions,
} from "../types";
import { type EventSchemas } from "./EventSchemas";
import { InngestFunction } from "./InngestFunction";
import { type InngestFunctionReference } from "./InngestFunctionReference";
import {
  InngestMiddleware,
  getHookStack,
  type ExtendWithMiddleware,
  type MiddlewareOptions,
  type MiddlewareRegisterFn,
  type MiddlewareRegisterReturn,
  type SendEventHookStack,
} from "./InngestMiddleware";

/**
 * Capturing the global type of fetch so that we can reliably access it below.
 */
type FetchT = typeof fetch;

/**
 * Given a set of client options for Inngest, return the event types that can
 * be sent or received.
 *
 * @public
 */
export type EventsFromOpts<TOpts extends ClientOptions> =
  TOpts["schemas"] extends EventSchemas<infer U>
    ? U
    : Record<string, EventPayload>;

/**
 * A client used to interact with the Inngest API by sending or reacting to
 * events.
 *
 * To provide event typing, see {@link EventSchemas}.
 *
 * ```ts
 * const inngest = new Inngest({ name: "My App" });
 *
 * // or to provide event typing too
 * const inngest = new Inngest({
 *   name: "My App",
 *   schemas: new EventSchemas().fromRecord<{
 *     "app/user.created": {
 *       data: { userId: string };
 *     };
 *   }>(),
 * });
 * ```
 *
 * @public
 */
export class Inngest<TOpts extends ClientOptions = ClientOptions> {
  /**
   * The ID of this instance, most commonly a reference to the application it
   * resides in.
   *
   * The ID of your client should remain the same for its lifetime; if you'd
   * like to change the name of your client as it appears in the Inngest UI,
   * change the `name` property instead.
   */
  public readonly id: string;

  /**
   * Inngest event key, used to send events to Inngest Cloud.
   */
  private eventKey = "";

  private readonly apiBaseUrl: string | undefined;
  private readonly eventBaseUrl: string | undefined;

  private readonly inngestApi: InngestApi;

  /**
   * The absolute URL of the Inngest Cloud API.
   */
  private sendEventUrl: URL = new URL(
    `e/${this.eventKey}`,
    defaultInngestEventBaseUrl
  );

  private readonly headers: Record<string, string>;

  private readonly fetch: FetchT;

  private readonly logger: Logger;

  /**
   * A promise that resolves when the middleware stack has been initialized and
   * the client is ready to be used.
   */
  private readonly middleware: Promise<MiddlewareRegisterReturn[]>;

  /**
   * Whether the client is running in a production environment. This can
   * sometimes be `undefined` if the client has expressed no preference or
   * perhaps environment variables are only available at a later stage in the
   * runtime, for example when receiving a request.
   *
   * An {@link InngestCommHandler} should prioritize this value over all other
   * settings, but should still check for the presence of an environment
   * variable if it is not set.
   */
  private readonly mode: Mode;

  /**
   * A client used to interact with the Inngest API by sending or reacting to
   * events.
   *
   * To provide event typing, see {@link EventSchemas}.
   *
   * ```ts
   * const inngest = new Inngest({ name: "My App" });
   *
   * // or to provide event typing too
   * const inngest = new Inngest({
   *   name: "My App",
   *   schemas: new EventSchemas().fromRecord<{
   *     "app/user.created": {
   *       data: { userId: string };
   *     };
   *   }>(),
   * });
   * ```
   */
  constructor({
    id,
    eventKey,
    baseUrl,
    fetch,
    env,
    logger = new DefaultLogger(),
    middleware,
    isDev,
  }: TOpts) {
    if (!id) {
      // TODO PrettyError
      throw new Error("An `id` must be passed to create an Inngest instance.");
    }

    this.id = id;

    this.mode = getMode({
      explicitMode:
        typeof isDev === "boolean" ? (isDev ? "dev" : "cloud") : undefined,
    });

    this.apiBaseUrl =
      baseUrl ||
      processEnv(envKeys.InngestApiBaseUrl) ||
      processEnv(envKeys.InngestBaseUrl) ||
      (this.mode.isExplicit
        ? this.mode.type === "cloud"
          ? defaultInngestApiBaseUrl
          : defaultDevServerHost
        : undefined);

    this.eventBaseUrl =
      baseUrl ||
      processEnv(envKeys.InngestEventApiBaseUrl) ||
      processEnv(envKeys.InngestBaseUrl) ||
      (this.mode.isExplicit
        ? this.mode.type === "cloud"
          ? defaultInngestEventBaseUrl
          : defaultDevServerHost
        : undefined);

    this.setEventKey(eventKey || processEnv(envKeys.InngestEventKey) || "");

    this.headers = inngestHeaders({
      inngestEnv: env,
    });

    this.fetch = getFetch(fetch);

    this.inngestApi = new InngestApi({
      baseUrl: this.apiBaseUrl || defaultInngestApiBaseUrl,
      signingKey: processEnv(envKeys.InngestSigningKey) || "",
      fetch: this.fetch,
    });

    this.logger = logger;

    this.middleware = this.initializeMiddleware([
      ...builtInMiddleware,
      ...(middleware || []),
    ]);
  }

  /**
   * Initialize all passed middleware, running the `register` function on each
   * in sequence and returning the requested hook registrations.
   */
  private async initializeMiddleware(
    middleware: InngestMiddleware<MiddlewareOptions>[] = [],
    opts?: {
      registerInput?: Omit<Parameters<MiddlewareRegisterFn>[0], "client">;
      prefixStack?: Promise<MiddlewareRegisterReturn[]>;
    }
  ): Promise<MiddlewareRegisterReturn[]> {
    /**
     * Wait for the prefix stack to run first; do not trigger ours before this
     * is complete.
     */
    const prefix = await (opts?.prefixStack ?? []);

    const stack = middleware.reduce<Promise<MiddlewareRegisterReturn[]>>(
      async (acc, m) => {
        // Be explicit about waiting for the previous middleware to finish
        const prev = await acc;
        const next = await m.init({ client: this, ...opts?.registerInput });

        return [...prev, next];
      },
      Promise.resolve([])
    );

    return [...prefix, ...(await stack)];
  }

  /**
   * Given a response from Inngest, relay the error to the caller.
   */
  private async getResponseError(
    response: globalThis.Response,
    foundErr = "Unknown error"
  ): Promise<Error> {
    let errorMessage = foundErr;

    if (errorMessage === "Unknown error") {
      switch (response.status) {
        case 401:
          errorMessage = "Event key Not Found";
          break;
        case 400:
          errorMessage = "Cannot process event payload";
          break;
        case 403:
          errorMessage = "Forbidden";
          break;
        case 404:
          errorMessage = "Event key not found";
          break;
        case 406:
          errorMessage = `${JSON.stringify(await response.json())}`;
          break;
        case 409:
        case 412:
          errorMessage = "Event transformation failed";
          break;
        case 413:
          errorMessage = "Event payload too large";
          break;
        case 500:
          errorMessage = "Internal server error";
          break;
        default:
          errorMessage = await response.text();
          break;
      }
    }

    return new Error(`Inngest API Error: ${response.status} ${errorMessage}`);
  }

  /**
   * Set the event key for this instance of Inngest. This is useful if for some
   * reason the key is not available at time of instantiation or present in the
   * `INNGEST_EVENT_KEY` environment variable.
   */
  public setEventKey(
    /**
     * Inngest event key, used to send events to Inngest Cloud. Use this is your
     * key is for some reason not available at time of instantiation or present
     * in the `INNGEST_EVENT_KEY` environment variable.
     */
    eventKey: string
  ): void {
    this.eventKey = eventKey || dummyEventKey;

    this.sendEventUrl = new URL(
      `e/${this.eventKey}`,
      this.eventBaseUrl || defaultInngestEventBaseUrl
    );
  }

  private eventKeySet(): boolean {
    return Boolean(this.eventKey) && this.eventKey !== dummyEventKey;
  }

  /**
   * Send one or many events to Inngest. Takes an entire payload (including
   * name) as each input.
   *
   * ```ts
   * await inngest.send({ name: "app/user.created", data: { id: 123 } });
   * ```
   *
   * Returns a promise that will resolve if the event(s) were sent successfully,
   * else throws with an error explaining what went wrong.
   *
   * If you wish to send an event with custom types (i.e. one that hasn't been
   * generated), make sure to add it when creating your Inngest instance, like
   * so:
   *
   * ```ts
   * const inngest = new Inngest({
   *   name: "My App",
   *   schemas: new EventSchemas().fromRecord<{
   *     "my/event": {
   *       name: "my/event";
   *       data: { bar: string };
   *     };
   *   }>(),
   * });
   * ```
   */
  public async send<Payload extends SendEventPayload<EventsFromOpts<TOpts>>>(
    payload: Payload
  ): Promise<SendEventOutput<TOpts>> {
    const hooks = await getHookStack(
      this.middleware,
      "onSendEvent",
      undefined,
      {
        transformInput: (prev, output) => {
          return { ...prev, ...output };
        },
        transformOutput(prev, output) {
          return {
            result: { ...prev.result, ...output?.result },
          };
        },
      }
    );

    let payloads: EventPayload[] = Array.isArray(payload)
      ? (payload as EventPayload[])
      : payload
        ? ([payload] as [EventPayload])
        : [];

    const inputChanges = await hooks.transformInput?.({
      payloads: [...payloads],
    });
    if (inputChanges?.payloads) {
      payloads = [...inputChanges.payloads];
    }

    // Ensure that we always add "ts" and "data" fields to events. "ts" is auto-
    // filled by the event server so is safe, and adding here fixes Next.js
    // server action cache issues.
    payloads = payloads.map((p) => {
      return {
        ...p,
        ts: p.ts || new Date().getTime(),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: p.data || {},
      };
    });

    const applyHookToOutput = async (
      arg: Parameters<NonNullable<SendEventHookStack["transformOutput"]>>[0]
    ): Promise<SendEventOutput<TOpts>> => {
      const hookOutput = await hooks.transformOutput?.(arg);
      return {
        ...arg.result,
        ...hookOutput?.result,
        // 🤮
      } as unknown as SendEventOutput<TOpts>;
    };

    /**
     * It can be valid for a user to send an empty list of events; if this
     * happens, show a warning that this may not be intended, but don't throw.
     */
    if (!payloads.length) {
      console.warn(
        prettyError({
          type: "warn",
          whatHappened: "`inngest.send()` called with no events",
          reassurance:
            "This is not an error, but you may not have intended to do this.",
          consequences:
            "The returned promise will resolve, but no events have been sent to Inngest.",
          stack: true,
        })
      );

      return await applyHookToOutput({ result: { ids: [] } });
    }

    // When sending events, check if the dev server is available.  If so, use the
    // dev server.
    let url = this.sendEventUrl.href;

    /**
     * If we're in prod mode and have no key, fail now.
     */
    if (this.mode.type === "cloud" && !this.eventKeySet()) {
      throw new Error(
        prettyError({
          whatHappened: "Failed to send event",
          consequences: "Your event or events were not sent to Inngest.",
          why: "We couldn't find an event key to use to send events to Inngest.",
          toFixNow: fixEventKeyMissingSteps,
        })
      );
    }

    /**
     * If we've inferred that we're in dev mode, try to hit the dev server
     * first to see if it exists. If it does, use it, otherwise fall back to
     * whatever server we have configured.
     *
     * `INNGEST_BASE_URL` is used to set both dev server and prod URLs, so if a
     * user has set this it means they have already chosen a URL to hit.
     */
    if (
      this.mode.type === "dev" &&
      !this.mode.isExplicit &&
      !this.eventBaseUrl
    ) {
      const devAvailable = await devServerAvailable(
        defaultDevServerHost,
        this.fetch
      );

      if (devAvailable) {
        url = devServerUrl(defaultDevServerHost, `e/${this.eventKey}`).href;
      }
    }

    const response = await this.fetch(url, {
      method: "POST",
      body: stringify(payloads),
      headers: { ...this.headers },
    });

    let body: SendEventResponse | undefined;

    try {
      const rawBody: unknown = await response.json();
      body = await sendEventResponseSchema.parseAsync(rawBody);
    } catch (err) {
      throw await this.getResponseError(response);
    }

    if (body.status / 100 !== 2 || body.error) {
      throw await this.getResponseError(response, body.error);
    }

    return await applyHookToOutput({ result: { ids: body.ids } });
  }

  public createFunction<
    TMiddleware extends MiddlewareStack,
    TTrigger extends TriggerOptions<TTriggerName>,
    TTriggerName extends keyof EventsFromOpts<TOpts> &
      string = EventNameFromTrigger<EventsFromOpts<TOpts>, TTrigger>,
    THandler extends Handler.Any = Handler<
      TOpts,
      EventsFromOpts<TOpts>,
      TTriggerName,
      ExtendWithMiddleware<
        [
          typeof builtInMiddleware,
          NonNullable<TOpts["middleware"]>,
          TMiddleware,
        ]
      >
    >,
  >(
    options: ExclusiveKeys<
      Omit<
        FunctionOptions<EventsFromOpts<TOpts>, TTriggerName>,
        "onFailure" | "middleware"
      > & {
        /**
         * Provide a function to be called if your function fails, meaning
         * that it ran out of retries and was unable to complete successfully.
         *
         * This is useful for sending warning notifications or cleaning up
         * after a failure and supports all the same functionality as a
         * regular handler.
         */
        onFailure?: Handler<
          TOpts,
          EventsFromOpts<TOpts>,
          TTriggerName,
          ExtendWithMiddleware<
            [
              typeof builtInMiddleware,
              NonNullable<TOpts["middleware"]>,
              TMiddleware,
            ],
            FailureEventArgs<EventsFromOpts<TOpts>[TTriggerName]>
          >
        >;

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
      },
      "batchEvents",
      "cancelOn" | "rateLimit"
    >,
    trigger: TTrigger,
    handler: THandler
  ): InngestFunction<
    TOpts,
    EventsFromOpts<TOpts>,
    TTrigger,
    FunctionOptions<
      EventsFromOpts<TOpts>,
      EventNameFromTrigger<EventsFromOpts<TOpts>, TTrigger>
    >,
    THandler
  > {
    let sanitizedOpts: FunctionOptions<
      EventsFromOpts<TOpts>,
      EventNameFromTrigger<EventsFromOpts<TOpts>, TTrigger>
    >;

    if (typeof options === "string") {
      // v2 -> v3 runtime migraton warning
      console.warn(
        `${logPrefix} InngestFunction: Creating a function with a string as the first argument has been deprecated in v3; pass an object instead. See https://www.inngest.com/docs/sdk/migration`
      );

      sanitizedOpts = { id: options };
    } else {
      sanitizedOpts = options as typeof sanitizedOpts;
    }

    let sanitizedTrigger: FunctionTrigger<TTriggerName>;

    if (typeof trigger === "string") {
      // v2 -> v3 migration warning
      console.warn(
        `${logPrefix} InngestFunction: Creating a function with a string as the second argument has been deprecated in v3; pass an object instead. See https://www.inngest.com/docs/sdk/migration`
      );

      sanitizedTrigger = {
        event: trigger,
      };
    } else if (trigger.event) {
      sanitizedTrigger = {
        event: trigger.event,
        expression: trigger.if,
      };
    } else {
      sanitizedTrigger = trigger;
    }

    if (Object.prototype.hasOwnProperty.call(sanitizedOpts, "fns")) {
      // v2 -> v3 migration warning
      console.warn(
        `${logPrefix} InngestFunction: \`fns\` option has been deprecated in v3; use \`middleware\` instead. See https://www.inngest.com/docs/sdk/migration`
      );
    }

    return new InngestFunction<
      TOpts,
      EventsFromOpts<TOpts>,
      TTrigger,
      FunctionOptions<
        EventsFromOpts<TOpts>,
        EventNameFromTrigger<EventsFromOpts<TOpts>, TTrigger>
      >,
      THandler
    >(this, sanitizedOpts, sanitizedTrigger as TTrigger, handler);
  }
}

/**
 * Default middleware that is included in every client, placed after the user's
 * middleware on the client but before function-level middleware.
 *
 * It is defined here to ensure that comments are included in the generated TS
 * definitions. Without this, we infer the stack of built-in middleware without
 * comments, losing a lot of value.
 *
 * If this is moved, please ensure that using this package in another project
 * can correctly access comments on mutated input and output.
 */
export const builtInMiddleware = (<T extends MiddlewareStack>(m: T): T => m)([
  new InngestMiddleware({
    name: "Inngest: Logger",
    init({ client }) {
      return {
        onFunctionRun(arg) {
          const { ctx } = arg;
          const metadata = {
            runID: ctx.runId,
            eventName: ctx.event.name,
            functionName: arg.fn.name,
          };

          let providedLogger: Logger = client["logger"];
          // create a child logger if the provided logger has child logger implementation
          try {
            if ("child" in providedLogger) {
              type ChildLoggerFn = (
                metadata: Record<string, unknown>
              ) => Logger;
              providedLogger = (providedLogger.child as ChildLoggerFn)(
                metadata
              );
            }
          } catch (err) {
            console.error('failed to create "childLogger" with error: ', err);
            // no-op
          }
          const logger = new ProxyLogger(providedLogger);

          return {
            transformInput() {
              return {
                ctx: {
                  /**
                   * The passed in logger from the user.
                   * Defaults to a console logger if not provided.
                   */
                  logger: logger as Logger,
                },
              };
            },
            beforeExecution() {
              logger.enable();
            },
            transformOutput({ result: { error } }) {
              if (error) {
                logger.error(error);
              }
            },
            async beforeResponse() {
              await logger.flush();
            },
          };
        },
      };
    },
  }),
]);

/**
 * A client used to interact with the Inngest API by sending or reacting to
 * events.
 *
 * To provide event typing, see {@link EventSchemas}.
 *
 * ```ts
 * const inngest = new Inngest({ name: "My App" });
 *
 * // or to provide event typing too
 * const inngest = new Inngest({
 *   name: "My App",
 *   schemas: new EventSchemas().fromRecord<{
 *     "app/user.created": {
 *       data: { userId: string };
 *     };
 *   }>(),
 * });
 * ```
 *
 * @public
 */
export namespace Inngest {
  /**
   * Represents any `Inngest` instance, regardless of generics and
   * inference.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Any = Inngest<any>;
}

/**
 * A helper type to extract the type of a set of event tooling from a given
 * Inngest instance and optionally a trigger.
 *
 * @example Get generic step tools for an Inngest instance.
 * ```ts
 * type StepTools = GetStepTools<typeof inngest>;
 * ```
 *
 * @example Get step tools with a trigger, ensuring tools like `waitForEvent` are typed.
 * ```ts
 * type StepTools = GetStepTools<typeof Inngest, "github/pull_request">;
 * ```
 *
 * @public
 */
export type GetStepTools<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TInngest extends Inngest<any>,
  TTrigger extends keyof GetEvents<TInngest> &
    string = keyof GetEvents<TInngest> & string,
> = GetFunctionInput<TInngest, TTrigger> extends { step: infer TStep }
  ? TStep
  : never;

/**
 * A helper type to extract the type of the input to a function from a given
 * Inngest instance and optionally a trigger.
 *
 * @example Get generic function input for an Inngest instance.
 * ```ts
 * type Input = GetFunctionInput<typeof inngest>;
 * ```
 *
 * @example Get function input with a trigger, ensuring tools like `waitForEvent` are typed.
 * ```ts
 * type Input = GetFunctionInput<typeof Inngest, "github/pull_request">;
 * ```
 *
 * @public
 */
export type GetFunctionInput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TInngest extends Inngest<any>,
  TTrigger extends keyof GetEvents<TInngest, true> & string = keyof GetEvents<
    TInngest,
    true
  > &
    string,
> = Parameters<
  Handler<
    ClientOptionsFromInngest<TInngest>,
    GetEvents<TInngest, true>,
    TTrigger,
    ExtendWithMiddleware<
      [
        typeof builtInMiddleware,
        NonNullable<ClientOptionsFromInngest<TInngest>["middleware"]>,
      ]
    >
  >
>[0];

/**
 * A helper type to extract the type of the output of an Inngest function.
 *
 * @example Get a function's output
 * ```ts
 * type Output = GetFunctionOutput<typeof myFunction>;
 * ```
 *
 * @public
 */
export type GetFunctionOutput<
  TFunction extends InvokeTargetFunctionDefinition,
> = TFunction extends InngestFunction.Any
  ? GetFunctionOutputFromInngestFunction<TFunction>
  : TFunction extends InngestFunctionReference.Any
    ? GetFunctionOutputFromReferenceInngestFunction<TFunction>
    : unknown;

/**
 * A helper type to extract the type of the output of an Inngest function.
 *
 * Used internally for {@link GetFunctionOutput}. Code outside of this package
 * should use {@link GetFunctionOutput} instead.
 *
 * @internal
 */
export type GetFunctionOutputFromInngestFunction<
  TFunction extends InngestFunction.Any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
> = TFunction extends InngestFunction<any, any, any, any, infer IHandler>
  ? IfNever<
      SimplifyDeep<Jsonify<Awaited<ReturnType<IHandler>>>>,
      null,
      SimplifyDeep<Jsonify<Awaited<ReturnType<IHandler>>>>
    >
  : unknown;

/**
 * A helper type to extract the type of the output of a referenced Inngest
 * function.
 *
 * Used internally for {@link GetFunctionOutput}. Code outside of this package
 * should use {@link GetFunctionOutput} instead.
 *
 * @internal
 */
export type GetFunctionOutputFromReferenceInngestFunction<
  TFunction extends InngestFunctionReference.Any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
> = TFunction extends InngestFunctionReference<any, infer IOutput>
  ? IfNever<
      SimplifyDeep<Jsonify<IOutput>>,
      null,
      SimplifyDeep<Jsonify<IOutput>>
    >
  : unknown;

/**
 * When passed an Inngest client, will return all event types for that client.
 *
 * It's recommended to use this instead of directly reusing your event types, as
 * Inngest will add extra properties and internal events such as `ts` and
 * `inngest/function.finished`.
 *
 * @example
 * ```ts
 * import { EventSchemas, Inngest, type GetEvents } from "inngest";
 *
 * export const inngest = new Inngest({
 *   id: "example-app",
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
export type GetEvents<
  TInngest extends Inngest.Any,
  TWithInternal extends boolean = false,
> = TWithInternal extends true
  ? EventsFromOpts<ClientOptionsFromInngest<TInngest>>
  : WithoutInternal<EventsFromOpts<ClientOptionsFromInngest<TInngest>>>;

/**
 * A helper type to extract the inferred options from a given Inngest instance.
 *
 * @example
 * ```ts
 * type Options = ClientOptionsFromInngest<typeof inngest>;
 * ```
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClientOptionsFromInngest<TInngest extends Inngest<any>> =
  TInngest extends Inngest<infer U> ? U : ClientOptions;
