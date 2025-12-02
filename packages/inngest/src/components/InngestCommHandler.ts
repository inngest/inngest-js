import debug from "debug";
import { ulid } from "ulid";
import { z } from "zod/v3";
import { getAsyncCtx } from "../experimental";
import {
  debugPrefix,
  defaultInngestApiBaseUrl,
  defaultInngestEventBaseUrl,
  defaultMaxRetries,
  dummyEventKey,
  ExecutionVersion,
  envKeys,
  forwardedHeaders,
  headerKeys,
  logPrefix,
  probe as probeEnum,
  queryKeys,
  syncKind,
} from "../helpers/consts.ts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver.ts";
import { enumFromValue } from "../helpers/enum.ts";
import {
  allProcessEnv,
  devServerHost,
  type Env,
  getFetch,
  getMode,
  getPlatformName,
  inngestHeaders,
  Mode,
  parseAsBoolean,
  platformSupportsStreaming,
} from "../helpers/env.ts";
import { rethrowError, serializeError } from "../helpers/errors.ts";
import {
  type FnData,
  fetchAllFnData,
  parseFnData,
  undefinedToNull,
} from "../helpers/functions.ts";
import { fetchWithAuthFallback, signDataWithKey } from "../helpers/net.ts";
import { runAsPromise } from "../helpers/promises.ts";
import { ServerTiming } from "../helpers/ServerTiming.ts";
import { createStream } from "../helpers/stream.ts";
import { hashEventKey, hashSigningKey, stringify } from "../helpers/strings.ts";
import type { MaybePromise } from "../helpers/types.ts";
import {
  type APIStepPayload,
  AsyncResponseType,
  type AsyncResponseValue,
  type AuthenticatedIntrospection,
  type EventPayload,
  type FunctionConfig,
  functionConfigSchema,
  type InBandRegisterRequest,
  inBandSyncRequestBodySchema,
  type LogLevel,
  logLevels,
  type OutgoingOp,
  type RegisterOptions,
  type RegisterRequest,
  StepMode,
  StepOpCode,
  type SupportedFrameworkName,
  type UnauthenticatedIntrospection,
} from "../types.ts";
import { version } from "../version.ts";
import {
  type ExecutionResult,
  type ExecutionResultHandler,
  type ExecutionResultHandlers,
  type InngestExecutionOptions,
  PREFERRED_EXECUTION_VERSION,
} from "./execution/InngestExecution.ts";
import { _internals } from "./execution/v1";
import type { Inngest } from "./Inngest.ts";
import {
  type CreateExecutionOptions,
  InngestFunction,
} from "./InngestFunction.ts";

/**
 * A set of options that can be passed to a serve handler, intended to be used
 * by internal and custom serve handlers to provide a consistent interface.
 *
 * @public
 */
export interface ServeHandlerOptions extends RegisterOptions {
  /**
   * The `Inngest` instance used to declare all functions.
   */
  client: Inngest.Like;

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly InngestFunction.Like[];
}

export interface SyncHandlerOptions extends RegisterOptions {
  /**
   * The `Inngest` instance used to declare all functions.
   */
  client: Inngest.Like;

  /**
   * The type of response you wish to return to an API endpoint when using steps
   * within it and we must transition to {@link StepMode.Async}.
   *
   * In most cases, this defaults to {@link AsyncResponseType.Redirect}.
   */
  asyncResponse?: AsyncResponseValue;

  /**
   * If defined, this sets the function ID that represents this endpoint.
   * Without this set, it defaults to using the detected method and path of the
   * request, for example: `GET /api/my-endpoint`.
   */
  functionId?: string;

  /**
   * Specifies the maximum number of retries for all steps.
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
}

export interface InternalServeHandlerOptions extends ServeHandlerOptions {
  /**
   * Can be used to override the framework name given to a particular serve
   * handler.
   */
  frameworkName?: string;

  /**
   * Can be used to force the handler to always execute functions regardless of
   * the request method or other factors.
   *
   * This is primarily intended for use with Inngest in APIs, where requests may
   * not have the usual shape of an Inngest payload, but we want to pull data
   * and execute.
   */
  // forceExecution?: boolean;
}

interface InngestCommHandlerOptions<
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  Input extends any[] = any[],
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  Output = any,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  StreamOutput = any,
> extends RegisterOptions {
  /**
   * The name of the framework this handler is designed for. Should be
   * lowercase, alphanumeric characters inclusive of `-` and `/`.
   *
   * This should never be defined by the user; a {@link ServeHandler} should
   * abstract this.
   */
  frameworkName: string;

  /**
   * The name of this serve handler, e.g. `"My App"`. It's recommended that this
   * value represents the overarching app/service that this set of functions is
   * being served from.
   *
   * This can also be an `Inngest` client, in which case the name given when
   * instantiating the client is used. This is useful if you're sending and
   * receiving events from the same service, as you can reuse a single
   * definition of Inngest.
   */
  client: Inngest.Like;

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions?: readonly InngestFunction.Like[];

  /**
   * The `handler` is the function that will be called with your framework's
   * request arguments and returns a set of functions that the SDK will use to
   * access various parts of the request, such as the body, headers, and query
   * string parameters.
   *
   * It also defines how to transform a response from the SDK into a response
   * that your framework can understand, ensuring headers, status codes, and
   * body are all set correctly.
   *
   * @example
   * ```ts
   * function handler (req: Request, res: Response) {
   *   return {
   *     method: () => req.method,
   *     body: () => req.json(),
   *     headers: (key) => req.headers.get(key),
   *     url: () => req.url,
   *     transformResponse: ({ body, headers, status }) => {
   *       return new Response(body, { status, headers });
   *     },
   *   };
   * };
   * ```
   *
   * See any existing handler for a full example.
   */
  handler: Handler<Input, Output, StreamOutput>;

  skipSignatureValidation?: boolean;

  /**
   * Options for when this comm handler executes a synchronous (API) function.
   */
  syncOptions?: SyncHandlerOptions;
}

/**
 * Capturing the global type of fetch so that we can reliably access it below.
 */
type FetchT = typeof fetch;

/**
 * A schema for the response from Inngest when registering.
 */
const registerResSchema = z.object({
  status: z.number().default(200),
  skipped: z.boolean().optional().default(false),
  modified: z.boolean().optional().default(false),
  error: z.string().default("Successfully registered"),
});

/**
 * `InngestCommHandler` is a class for handling incoming requests from Inngest (or
 * Inngest's tooling such as the dev server or CLI) and taking appropriate
 * action for any served functions.
 *
 * All handlers (Next.js, RedwoodJS, Remix, Deno Fresh, etc.) are created using
 * this class; the exposed `serve` function will - most commonly - create an
 * instance of `InngestCommHandler` and then return `instance.createHandler()`.
 *
 * See individual parameter details for more information, or see the
 * source code for an existing handler, e.g.
 * {@link https://github.com/inngest/inngest-js/blob/main/src/next.ts}
 *
 * @example
 * ```
 * // my-custom-handler.ts
 * import {
 *   InngestCommHandler,
 *   type ServeHandlerOptions,
 * } from "./components/InngestCommHandler";
 *
 * export const serve = (options: ServeHandlerOptions) => {
 *   const handler = new InngestCommHandler({
 *     frameworkName: "my-custom-handler",
 *     ...options,
 *     handler: (req: Request) => {
 *       return {
 *         body: () => req.json(),
 *         headers: (key) => req.headers.get(key),
 *         method: () => req.method,
 *         url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
 *         transformResponse: ({ body, status, headers }) => {
 *           return new Response(body, { status, headers });
 *         },
 *       };
 *     },
 *   });
 *
 *   return handler.createHandler();
 * };
 * ```
 *
 * @public
 */
export class InngestCommHandler<
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  Input extends any[] = any[],
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  Output = any,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  StreamOutput = any,
> {
  /**
   * The ID of this serve handler, e.g. `"my-app"`. It's recommended that this
   * value represents the overarching app/service that this set of functions is
   * being served from.
   */
  public readonly id: string;

  /**
   * The handler specified during instantiation of the class.
   */
  public readonly handler: Handler;

  /**
   * The URL of the Inngest function registration endpoint.
   */
  private readonly inngestRegisterUrl: URL;

  /**
   * The name of the framework this handler is designed for. Should be
   * lowercase, alphanumeric characters inclusive of `-` and `/`.
   */
  protected readonly frameworkName: string;

  /**
   * The signing key used to validate requests from Inngest. This is
   * intentionally mutable so that we can pick up the signing key from the
   * environment during execution if needed.
   */
  protected signingKey: string | undefined;

  /**
   * The same as signingKey, except used as a fallback when auth fails using the
   * primary signing key.
   */
  protected signingKeyFallback: string | undefined;

  /**
   * A property that can be set to indicate whether we believe we are in
   * production mode.
   *
   * Should be set every time a request is received.
   */
  protected _mode: Mode | undefined;

  /**
   * The localized `fetch` implementation used by this handler.
   */
  private readonly fetch: FetchT;

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
  private readonly _serveHost: string | undefined;

  /**
   * The path to the Inngest serve endpoint. e.g.:
   *
   *     "/some/long/path/to/inngest/endpoint"
   *
   * By default, the library will try to infer this using request details such
   * as the "Host" header and request path, but sometimes this isn't possible
   * (e.g. when running in a more controlled environments such as AWS Lambda or
   * when dealing with proxies/redirects).
   *
   * Provide the custom path (excluding the hostname) here to ensure that the
   * path is reported correctly when registering functions with Inngest.
   *
   * To also provide a custom hostname, use `serveHost`.
   */
  private readonly _servePath: string | undefined;

  /**
   * The minimum level to log from the Inngest serve handler.
   */
  protected readonly logLevel: LogLevel;

  protected readonly streaming: RegisterOptions["streaming"];

  /**
   * A private collection of just Inngest functions, as they have been passed
   * when instantiating the class.
   */
  private readonly rawFns: InngestFunction.Any[];

  private readonly client: Inngest.Any;

  /**
   * A private collection of functions that are being served. This map is used
   * to find and register functions when interacting with Inngest Cloud.
   */
  private readonly fns: Record<
    string,
    { fn: InngestFunction.Any; onFailure: boolean }
  > = {};

  private env: Env = allProcessEnv();

  private allowExpiredSignatures: boolean;

  private readonly _options: InngestCommHandlerOptions<
    Input,
    Output,
    StreamOutput
  >;

  private readonly skipSignatureValidation: boolean;

  constructor(options: InngestCommHandlerOptions<Input, Output, StreamOutput>) {
    // Set input options directly so we can reference them later
    this._options = options;

    /**
     * v2 -> v3 migration error.
     *
     * If a serve handler is passed a client as the first argument, it'll be
     * spread in to these options. We should be able to detect this by picking
     * up a unique property on the object.
     */
    if (Object.hasOwn(options, "eventKey")) {
      throw new Error(
        `${logPrefix} You've passed an Inngest client as the first argument to your serve handler. This is no longer supported in v3; please pass the Inngest client as the \`client\` property of an options object instead. See https://www.inngest.com/docs/sdk/migration`,
      );
    }

    this.frameworkName = options.frameworkName;
    this.client = options.client as Inngest.Any;

    if (options.id) {
      console.warn(
        `${logPrefix} The \`id\` serve option is deprecated and will be removed in v4`,
      );
    }
    this.id = options.id || this.client.id;

    this.handler = options.handler as Handler;

    /**
     * Provide a hidden option to allow expired signatures to be accepted during
     * testing.
     */
    this.allowExpiredSignatures = Boolean(
      // biome-ignore lint/complexity/noArguments: <explanation>
      arguments["0"]?.__testingAllowExpiredSignatures,
    );

    // Ensure we filter any undefined functions in case of missing imports.
    this.rawFns = (options.functions?.filter(Boolean) ??
      []) as InngestFunction.Any[];

    if (this.rawFns.length !== (options.functions ?? []).length) {
      // TODO PrettyError
      console.warn(
        `Some functions passed to serve() are undefined and misconfigured.  Please check your imports.`,
      );
    }

    this.fns = this.rawFns.reduce<
      Record<string, { fn: InngestFunction.Any; onFailure: boolean }>
    >((acc, fn) => {
      const configs = fn["getConfig"]({
        baseUrl: new URL("https://example.com"),
        appPrefix: this.id,
      });

      const fns = configs.reduce((acc, { id }, index) => {
        return { ...acc, [id]: { fn, onFailure: Boolean(index) } };
      }, {});

      // biome-ignore lint/complexity/noForEach: <explanation>
      configs.forEach(({ id }) => {
        if (acc[id]) {
          // TODO PrettyError
          throw new Error(
            `Duplicate function ID "${id}"; please change a function's name or provide an explicit ID to avoid conflicts.`,
          );
        }
      });

      return {
        ...acc,
        ...fns,
      };
    }, {});

    this.inngestRegisterUrl = new URL("/fn/register", this.apiBaseUrl);

    this.signingKey = options.signingKey;
    this.signingKeyFallback = options.signingKeyFallback;
    this._serveHost = options.serveHost || this.env[envKeys.InngestServeHost];
    this._servePath = options.servePath || this.env[envKeys.InngestServePath];

    this.skipSignatureValidation = options.skipSignatureValidation || false;

    const defaultLogLevel: typeof this.logLevel = "info";
    this.logLevel = z
      .enum(logLevels)
      .default(defaultLogLevel)
      .catch((ctx) => {
        this.log(
          "warn",
          `Unknown log level passed: ${String(
            ctx.input,
          )}; defaulting to ${defaultLogLevel}`,
        );

        return defaultLogLevel;
      })
      .parse(options.logLevel || this.env[envKeys.InngestLogLevel]);

    if (this.logLevel === "debug") {
      /**
       * `debug` is an old library; sometimes its runtime detection doesn't work
       * for newer pairings of framework/runtime.
       *
       * One silly symptom of this is that `Debug()` returns an anonymous
       * function with no extra properties instead of a `Debugger` instance if
       * the wrong code is consumed following a bad detection. This results in
       * the following `.enable()` call failing, so we just try carefully to
       * enable it here.
       */
      if (debug.enable && typeof debug.enable === "function") {
        debug.enable(`${debugPrefix}:*`);
      }
    }

    const defaultStreamingOption: typeof this.streaming = false;
    this.streaming = z
      .union([z.enum(["allow", "force"]), z.literal(false)])
      .default(defaultStreamingOption)
      .catch((ctx) => {
        this.log(
          "warn",
          `Unknown streaming option passed: ${String(
            ctx.input,
          )}; defaulting to ${String(defaultStreamingOption)}`,
        );

        return defaultStreamingOption;
      })
      .parse(options.streaming || this.env[envKeys.InngestStreaming]);

    this.fetch = options.fetch ? getFetch(options.fetch) : this.client["fetch"];
  }

  /**
   * Get the API base URL for the Inngest API.
   *
   * This is a getter to encourage checking the environment for the API base URL
   * each time it's accessed, as it may change during execution.
   */
  protected get apiBaseUrl(): string {
    return (
      this._options.baseUrl ||
      this.env[envKeys.InngestApiBaseUrl] ||
      this.env[envKeys.InngestBaseUrl] ||
      this.client.apiBaseUrl ||
      defaultInngestApiBaseUrl
    );
  }

  /**
   * Get the event API base URL for the Inngest API.
   *
   * This is a getter to encourage checking the environment for the event API
   * base URL each time it's accessed, as it may change during execution.
   */
  protected get eventApiBaseUrl(): string {
    return (
      this._options.baseUrl ||
      this.env[envKeys.InngestEventApiBaseUrl] ||
      this.env[envKeys.InngestBaseUrl] ||
      this.client.eventBaseUrl ||
      defaultInngestEventBaseUrl
    );
  }

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
  protected get serveHost(): string | undefined {
    return this._serveHost || this.env[envKeys.InngestServeHost];
  }

  /**
   * The path to the Inngest serve endpoint. e.g.:
   *
   *     "/some/long/path/to/inngest/endpoint"
   *
   * By default, the library will try to infer this using request details such
   * as the "Host" header and request path, but sometimes this isn't possible
   * (e.g. when running in a more controlled environments such as AWS Lambda or
   * when dealing with proxies/redirects).
   *
   * Provide the custom path (excluding the hostname) here to ensure that the
   * path is reported correctly when registering functions with Inngest.
   *
   * To also provide a custom hostname, use `serveHost`.
   *
   * This is a getter to encourage checking the environment for the serve path
   * each time it's accessed, as it may change during execution.
   */
  protected get servePath(): string | undefined {
    return this._servePath || this.env[envKeys.InngestServePath];
  }

  private get hashedEventKey(): string | undefined {
    if (!this.client["eventKey"] || this.client["eventKey"] === dummyEventKey) {
      return undefined;
    }
    return hashEventKey(this.client["eventKey"]);
  }

  // hashedSigningKey creates a sha256 checksum of the signing key with the
  // same signing key prefix.
  private get hashedSigningKey(): string | undefined {
    if (!this.signingKey) {
      return undefined;
    }
    return hashSigningKey(this.signingKey);
  }

  private get hashedSigningKeyFallback(): string | undefined {
    if (!this.signingKeyFallback) {
      return undefined;
    }
    return hashSigningKey(this.signingKeyFallback);
  }

  /**
   * Returns a `boolean` representing whether this handler will stream responses
   * or not. Takes into account the user's preference and the platform's
   * capabilities.
   */
  private async shouldStream(
    actions: HandlerResponseWithErrors,
  ): Promise<boolean> {
    const rawProbe = await actions.queryStringWithDefaults(
      "testing for probe",
      queryKeys.Probe,
    );
    if (rawProbe !== undefined) {
      return false;
    }

    // We must be able to stream responses to continue.
    if (!actions.transformStreamingResponse) {
      return false;
    }

    // If the user has forced streaming, we should always stream.
    if (this.streaming === "force") {
      return true;
    }

    // If the user has allowed streaming, we should stream if the platform
    // supports it.
    return (
      this.streaming === "allow" &&
      platformSupportsStreaming(
        this.frameworkName as SupportedFrameworkName,
        this.env,
      )
    );
  }

  private async isInngestReq(
    actions: HandlerResponseWithErrors,
  ): Promise<boolean> {
    const reqMessage = `checking if this is an Inngest request`;

    const [runId, signature] = await Promise.all([
      actions.headers(reqMessage, headerKeys.InngestRunId),
      actions.headers(reqMessage, headerKeys.Signature),
    ]);

    // Note that the signature just has to be present; in Dev it'll be empty,
    // but still set to `""`.
    return Boolean(runId && typeof signature === "string");
  }

  /**
   * Start handling a request, setting up environments, modes, and returning
   * some helpers.
   */
  private async initRequest(...args: Input): Promise<{
    timer: ServerTiming;
    actions: HandlerResponseWithErrors;
    getHeaders: () => Promise<Record<string, string>>;
  }> {
    const timer = new ServerTiming();
    const actions = await this.getActions(timer, ...args);

    const [env, expectedServerKind] = await Promise.all([
      actions.env?.("starting to handle request"),
      actions.headers(
        "checking expected server kind",
        headerKeys.InngestServerKind,
      ),
    ]);

    // Always make sure to merge whatever env we've been given with
    // `process.env`; some platforms may not provide all the necessary
    // environment variables or may use two sources.
    this.env = {
      ...allProcessEnv(),
      ...env,
    };

    const headerPromises = forwardedHeaders.map(async (header) => {
      const value = await actions.headers(
        `fetching ${header} for forwarding`,
        header,
      );

      return { header, value };
    });

    const headersToForwardP = Promise.all(headerPromises).then(
      (fetchedHeaders) => {
        return fetchedHeaders.reduce<Record<string, string>>(
          (acc, { header, value }) => {
            if (value) {
              acc[header] = value;
            }

            return acc;
          },
          {},
        );
      },
    );

    const getHeaders = async (): Promise<Record<string, string>> => ({
      ...inngestHeaders({
        env: this.env,
        framework: this.frameworkName,
        client: this.client,
        expectedServerKind: expectedServerKind || undefined,
        extras: {
          "Server-Timing": timer.getHeader(),
        },
      }),
      ...(await headersToForwardP),
    });

    const assumedMode = getMode({ env: this.env, client: this.client });

    if (assumedMode.isExplicit) {
      this._mode = assumedMode;
    } else {
      const serveIsProd = await actions.isProduction?.(
        "starting to handle request",
      );
      if (typeof serveIsProd === "boolean") {
        this._mode = new Mode({
          type: serveIsProd ? "cloud" : "dev",
          isExplicit: false,
        });
      } else {
        this._mode = assumedMode;
      }
    }

    this.upsertKeysFromEnv();

    return {
      timer,
      actions,
      getHeaders,
    };
  }

  /**
   * `createSyncHandler` should be used to return a type-equivalent version of
   * the `handler` specified during instantiation.
   */
  public createSyncHandler<
    THandler extends (...args: Input) => Promise<Awaited<Output>>,
  >(): (handler: THandler) => THandler {
    // Return a function that can be used to wrap endpoints
    return (handler) => {
      return this.wrapHandler((async (...args) => {
        const reqInit = await this.initRequest(...args);

        const fn = new InngestFunction(
          this.client,
          {
            id: this._options.syncOptions?.functionId ?? "",
            retries: this._options.syncOptions?.retries ?? defaultMaxRetries,
          },
          () => handler(...args),
        );

        // Decide if this request looks like an Inngest request. If it does,
        // we'll just use the regular `serve()` handler for this request, as
        // it's async.
        if (await this.isInngestReq(reqInit.actions)) {
          // If we have a run ID, we can just use the normal serve path
          // return this.createHandler()(...args);
          return this.handleAsyncRequest({
            ...reqInit,
            forceExecution: true,
            args,
            fns: [fn],
          });
        }

        // Otherwise, we know this is a sync request, so we can proceed with
        // creating a sync request to Inngest.
        return this.handleSyncRequest({
          ...reqInit,
          args,
          asyncMode:
            this._options.syncOptions?.asyncResponse ??
            AsyncResponseType.Redirect,
          fn,
        });
      }) as THandler);
    };
  }

  /**
   * `createHandler` should be used to return a type-equivalent version of the
   * `handler` specified during instantiation.
   *
   * @example
   * ```
   * // my-custom-handler.ts
   * import {
   *   InngestCommHandler,
   *   type ServeHandlerOptions,
   * } from "./components/InngestCommHandler";
   *
   * export const serve = (options: ServeHandlerOptions) => {
   *   const handler = new InngestCommHandler({
   *     frameworkName: "my-custom-handler",
   *     ...options,
   *     handler: (req: Request) => {
   *       return {
   *         body: () => req.json(),
   *         headers: (key) => req.headers.get(key),
   *         method: () => req.method,
   *         url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
   *         transformResponse: ({ body, status, headers }) => {
   *           return new Response(body, { status, headers });
   *         },
   *       };
   *     },
   *   });
   *
   *   return handler.createHandler();
   * };
   * ```
   */
  public createHandler<
    THandler extends (...args: Input) => Promise<Awaited<Output>>,
  >(): THandler {
    return this.wrapHandler((async (...args) => {
      return this.handleAsyncRequest({
        ...(await this.initRequest(...args)),
        args,
      });
    }) as THandler);
  }

  /**
   * Given a set of actions that let us access the incoming request, create a
   * `http/run.started` event that repesents a run starting from an HTTP
   * request.
   */
  private async createHttpEvent(
    actions: HandlerResponseWithErrors,
    fn: InngestFunction.Any,
  ): Promise<APIStepPayload> {
    const reason = "creating sync event";

    const contentTypePromise = actions
      .headers(reason, headerKeys.ContentType)
      .then((v) => v ?? "");

    const ipPromise = actions
      .headers(reason, headerKeys.ForwardedFor)
      .then((v) => {
        if (v) return v;

        return actions.headers(reason, headerKeys.RealIp).then((v) => v ?? "");
      });

    const methodPromise = actions.method(reason);

    const urlPromise = actions.url(reason).then((v) => this.reqUrl(v));

    const domainPromise = urlPromise.then(
      (url) => `${url.protocol}//${url.host}`,
    );

    const pathPromise = urlPromise.then((url) => url.pathname);

    const queryParamsPromise = urlPromise.then((url) =>
      url.searchParams.toString(),
    );

    // TODO For body, we can add `textBody()` to the actions
    const bodyPromise = actions.textBody!(reason).then((body) => {
      return typeof body === "string" ? body : stringify(body);
    });

    const [contentType, domain, ip, method, path, queryParams, body] =
      await Promise.all([
        contentTypePromise,
        domainPromise,
        ipPromise,
        methodPromise,
        pathPromise,
        queryParamsPromise,
        bodyPromise,
      ]);

    return {
      name: "http/run.started",
      data: {
        content_type: contentType,
        domain,
        ip,
        method,
        path,
        query_params: queryParams,
        body,
        fn: fn.id(),
      },
    };
  }

  private async handleSyncRequest({
    timer,
    actions,
    fn,
    asyncMode,
    args,
  }: {
    timer: ServerTiming;
    actions: HandlerResponseWithErrors;
    fn: InngestFunction.Any;
    asyncMode: AsyncResponseValue;
    args: unknown[];
  }): Promise<Awaited<Output>> {
    // Do we have actions for handling sync requests? We must!
    if (!actions.experimentalTransformSyncResponse) {
      throw new Error(
        "This platform does not support synchronous Inngest function executions.",
      );
    }

    // Check we're not in a context already...
    const ctx = await getAsyncCtx();
    if (ctx) {
      throw new Error(
        "We already seem to be in the context of an Inngest execution, but didn't expect to be. Did you already wrap this handler?",
      );
    }

    // We create a new run ID here in the SDK.
    const runId = ulid();
    const event = await this.createHttpEvent(actions, fn);

    // TODO Nope. Should be v2, so we now have two preferred versions...
    const exeVersion = PREFERRED_EXECUTION_VERSION;

    const exe = fn["createExecution"]({
      version: exeVersion,
      partialOptions: {
        client: this.client,
        data: {
          runId,
          event,
          attempt: 0,
          events: [event],
          maxAttempts: fn.opts.retries ?? defaultMaxRetries,
        },
        runId,
        headers: {},
        reqArgs: args,
        stepCompletionOrder: [],
        stepState: {},
        disableImmediateExecution: false,
        isFailureHandler: false,
        timer,
        createResponse: (data: unknown) =>
          actions.experimentalTransformSyncResponse!(
            "creating sync execution",
            data,
          ).then((res) => ({
            ...res,
            version: exeVersion,
          })),
        stepMode: StepMode.Sync,
      },
    });

    const result = await exe.start();

    const resultHandlers: ExecutionResultHandlers<unknown> = {
      "step-not-found": () => {
        throw new Error(
          "We should not get the result 'step-not-found' when checkpointing. This is a bug in the `inngest` SDK",
        );
      },
      "steps-found": () => {
        throw new Error(
          "We should not get the result 'steps-found' when checkpointing. This is a bug in the `inngest` SDK",
        );
      },
      "step-ran": () => {
        throw new Error(
          "We should not get the result 'step-ran' when checkpointing. This is a bug in the `inngest` SDK",
        );
      },
      "function-rejected": () => {
        throw new Error(
          "We should not get the result 'function-rejected' when checkpointing. This is a bug in the `inngest` SDK",
        );
      },
      "function-resolved": ({ data }) => {
        // We're done and we didn't call any step tools, so just return the
        // response.
        return data;
      },
      "change-mode": async ({ token }) => {
        switch (asyncMode) {
          case AsyncResponseType.Redirect: {
            return actions.transformResponse(
              "creating sync->async redirect response",
              {
                status: 302,
                headers: {
                  [headerKeys.Location]: await this.client["inngestApi"]
                    ["getTargetUrl"](
                      `/v1/http/runs/${runId}/output?token=${token}`,
                    )
                    .then((url) => url.toString()),
                },
                version: exeVersion,
                body: "",
              },
            );
          }

          case AsyncResponseType.Token: {
            return actions.transformResponse(
              "creating sync->async token response",
              {
                status: 200,
                headers: {},
                version: exeVersion,
                body: stringify({ run_id: runId, token }),
              },
            );
          }

          default: {
            // TODO user-provided hook mate, incl. req args
            break;
          }
        }

        throw new Error("Not implemented: change-mode");
      },
    };

    const resultHandler = resultHandlers[
      result.type
    ] as ExecutionResultHandler<unknown>;
    if (!resultHandler) {
      throw new Error(
        `No handler for execution result type: ${result.type}. This is a bug in the \`inngest\` SDK`,
      );
    }

    return resultHandler(result) as Awaited<Output>;
  }

  private async handleAsyncRequest({
    timer,
    actions,
    args,
    getHeaders,
    forceExecution,
    fns,
  }: {
    timer: ServerTiming;
    actions: HandlerResponseWithErrors;
    args: Input;
    getHeaders: () => Promise<Record<string, string>>;
    forceExecution?: boolean;
    fns?: InngestFunction.Any[];
  }): Promise<Awaited<Output>> {
    if (forceExecution && !actions.experimentalTransformSyncResponse) {
      throw new Error(
        "This platform does not support async executions in Inngest for APIs.",
      );
    }

    const methodP = actions.method("starting to handle request");

    const contentLength = await actions
      .headers("checking signature for request", headerKeys.ContentLength)
      .then((value) => {
        if (!value) {
          return undefined;
        }
        return Number.parseInt(value, 10);
      });

    const [signature, method, body] = await Promise.all([
      actions
        .headers("checking signature for request", headerKeys.Signature)
        .then((headerSignature) => {
          return headerSignature ?? undefined;
        }),
      methodP,
      methodP.then((method) => {
        if (method === "POST" || method === "PUT") {
          if (!contentLength) {
            // Return empty string because req.json() will throw an error.
            return "";
          }

          return actions.body(
            `checking body for request signing as method is ${method}`,
          );
        }

        return "";
      }),
    ]);

    const signatureValidation = this.validateSignature(signature, body);

    const actionRes = timer.wrap("action", () =>
      this.handleAction({
        actions,
        timer,
        getHeaders,
        reqArgs: args,
        signatureValidation,
        body,
        method,
        forceExecution: Boolean(forceExecution),
        fns,
      }),
    );

    /**
     * Prepares an action response by merging returned data to provide
     * trailing information such as `Server-Timing` headers.
     *
     * It should always prioritize the headers returned by the action, as they
     * may contain important information such as `Content-Type`.
     */
    const prepareActionRes = async (
      res: ActionResponse,
    ): Promise<ActionResponse> => {
      const headers: Record<string, string> = {
        ...(await getHeaders()),
        ...res.headers,
        ...(res.version === null
          ? {}
          : {
              [headerKeys.RequestVersion]: (
                res.version ?? PREFERRED_EXECUTION_VERSION
              ).toString(),
            }),
      };

      let signature: string | undefined;

      try {
        signature = await signatureValidation.then((result) => {
          if (!result.success || !result.keyUsed) {
            return undefined;
          }

          return this.getResponseSignature(result.keyUsed, res.body);
        });
      } catch (err) {
        // If we fail to sign, retun a 500 with the error.
        return {
          ...res,
          headers,
          body: stringify(serializeError(err)),
          status: 500,
        };
      }

      if (signature) {
        headers[headerKeys.Signature] = signature;
      }

      return {
        ...res,
        headers,
      };
    };

    if (await this.shouldStream(actions)) {
      const method = await actions.method("starting streaming response");

      if (method === "POST") {
        const { stream, finalize } = await createStream();

        /**
         * Errors are handled by `handleAction` here to ensure that an
         * appropriate response is always given.
         */
        void actionRes.then((res) => {
          return finalize(prepareActionRes(res));
        });

        return timer.wrap("res", async () => {
          return actions.transformStreamingResponse?.(
            "starting streaming response",
            {
              status: 201,
              headers: await getHeaders(),
              body: stream,
              version: null,
            },
          );
        });
      }
    }

    return timer.wrap("res", async () => {
      return actionRes.then(prepareActionRes).then((actionRes) => {
        return actions.transformResponse("sending back response", actionRes);
      });
    });
  }

  private async getActions(
    timer: ServerTiming,
    ...args: Input
  ): Promise<HandlerResponseWithErrors> {
    /**
     * Used for testing, allow setting action overrides externally when
     * calling the handler. Always search the final argument.
     */
    const lastArg = args[args.length - 1] as unknown;
    const actionOverrides =
      typeof lastArg === "object" &&
      lastArg !== null &&
      "actionOverrides" in lastArg &&
      typeof lastArg["actionOverrides"] === "object" &&
      lastArg["actionOverrides"] !== null
        ? lastArg["actionOverrides"]
        : {};

    /**
     * We purposefully `await` the handler, as it could be either sync or
     * async.
     */
    const rawActions = {
      ...(await timer
        .wrap("handler", () => this.handler(...args))
        .catch(rethrowError("Serve handler failed to run"))),
      ...actionOverrides,
    };

    /**
     * Map over every `action` in `rawActions` and create a new `actions`
     * object where each function is safely promisified with each access
     * requiring a reason.
     *
     * This helps us provide high quality errors about what's going wrong for
     * each access without having to wrap every access in a try/catch.
     */
    const promisifiedActions: ActionHandlerResponseWithErrors = Object.entries(
      rawActions,
    ).reduce((acc, [key, value]) => {
      if (typeof value !== "function") {
        return acc;
      }

      return {
        ...acc,
        [key]: (reason: string, ...args: unknown[]) => {
          const errMessage = [
            `Failed calling \`${key}\` from serve handler`,
            reason,
          ]
            .filter(Boolean)
            .join(" when ");

          const fn = () => (value as (...args: unknown[]) => unknown)(...args);

          return runAsPromise(fn)
            .catch(rethrowError(errMessage))
            .catch((err) => {
              this.log("error", err);
              throw err;
            });
        },
      };
    }, {} as ActionHandlerResponseWithErrors);

    /**
     * Mapped promisified handlers from userland `serve()` function mixed in
     * with some helpers.
     */
    const actions: HandlerResponseWithErrors = {
      ...promisifiedActions,
      queryStringWithDefaults: async (
        reason: string,
        key: string,
      ): Promise<string | undefined> => {
        const url = await actions.url(reason);

        const ret =
          (await actions.queryString?.(reason, key, url)) ||
          url.searchParams.get(key) ||
          undefined;

        return ret;
      },
      ...actionOverrides,
    };

    return actions;
  }

  // biome-ignore lint/suspicious/noExplicitAny: any fn
  private wrapHandler<THandler extends (...args: any[]) => any>(
    handler: THandler,
  ): THandler {
    /**
     * Some platforms check (at runtime) the length of the function being used
     * to handle an endpoint. If this is a variadic function, it will fail that
     * check.
     *
     * Therefore, we expect the arguments accepted to be the same length as the
     * `handler` function passed internally.
     *
     * We also set a name to avoid a common useless name in tracing such as
     * `"anonymous"` or `"bound function"`.
     *
     * https://github.com/getsentry/sentry-javascript/issues/3284
     */
    Object.defineProperties(handler, {
      name: {
        value: "InngestHandler",
      },
      length: {
        value: this.handler.length,
      },
    });

    return handler;
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in the SDK
  private get mode(): Mode | undefined {
    return this._mode;
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in the SDK
  private set mode(m) {
    this._mode = m;

    if (m) {
      this.client["mode"] = m;
    }
  }

  /**
   * Given a set of functions to check if an action is available from the
   * instance's handler, enact any action that is found.
   *
   * This method can fetch varying payloads of data, but ultimately is the place
   * where _decisions_ are made regarding functionality.
   *
   * For example, if we find that we should be viewing the UI, this function
   * will decide whether the UI should be visible based on the payload it has
   * found (e.g. env vars, options, etc).
   */
  private async handleAction({
    actions,
    timer,
    getHeaders,
    reqArgs,
    signatureValidation,
    body: rawBody,
    method,
    forceExecution,
    fns,
  }: {
    actions: HandlerResponseWithErrors;
    timer: ServerTiming;
    getHeaders: () => Promise<Record<string, string>>;
    reqArgs: unknown[];
    signatureValidation: ReturnType<InngestCommHandler["validateSignature"]>;
    body: unknown;
    method: string;
    forceExecution: boolean;
    fns?: InngestFunction.Any[];
  }): Promise<ActionResponse> {
    // This is when the request body is completely missing; it does not
    // include an empty body. This commonly happens when the HTTP framework
    // doesn't have body parsing middleware.
    const isMissingBody = rawBody === undefined;
    let body = rawBody;

    try {
      let url = await actions.url("starting to handle request");

      if (method === "POST" || forceExecution) {
        if (!forceExecution && isMissingBody) {
          this.log(
            "error",
            "Missing body when executing, possibly due to missing request body middleware",
          );

          return {
            status: 500,
            headers: {
              "Content-Type": "application/json",
            },
            body: stringify(
              serializeError(
                new Error(
                  "Missing request body when executing, possibly due to missing request body middleware",
                ),
              ),
            ),
            version: undefined,
          };
        }

        const validationResult = await signatureValidation;
        if (!validationResult.success) {
          return {
            status: 401,
            headers: {
              "Content-Type": "application/json",
            },
            body: stringify(serializeError(validationResult.err)),
            version: undefined,
          };
        }

        let fn: { fn: InngestFunction.Any; onFailure: boolean } | undefined;
        let fnId: string | undefined;
        let stepId: string | null | undefined;

        if (forceExecution) {
          fn =
            fns?.length && fns[0]
              ? { fn: fns[0], onFailure: false }
              : Object.values(this.fns)[0];
          fnId = fn?.fn.id();
          stepId = "step"; // Checkpointed runs are never parallel atm, so this is hardcoded
          body = {
            event: {},
            events: [],
            steps: {},
            version: PREFERRED_EXECUTION_VERSION,
            ctx: {
              attempt: 0,
              disable_immediate_execution: false,
              use_api: true,
              max_attempts: 3,
              run_id: await actions.headers(
                "getting run ID for forced execution",
                headerKeys.InngestRunId,
              ),
              // TODO We need this to be given to us or the API to return it
              stack: { stack: [], current: 0 },
            },
          } as Extract<FnData, { version: typeof PREFERRED_EXECUTION_VERSION }>;
        } else {
          const rawProbe = await actions.queryStringWithDefaults(
            "testing for probe",
            queryKeys.Probe,
          );
          if (rawProbe) {
            const probe = enumFromValue(probeEnum, rawProbe);
            if (!probe) {
              // If we're here, we've received a probe that we don't recognize.
              // Fail.
              return {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                },
                body: stringify(
                  serializeError(new Error(`Unknown probe "${rawProbe}"`)),
                ),
                version: undefined,
              };
            }

            // Provide actions for every probe available.
            const probeActions: Record<
              probeEnum,
              () => MaybePromise<ActionResponse>
            > = {
              [probeEnum.Trust]: () => ({
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                },
                body: "",
                version: undefined,
              }),
            };

            return probeActions[probe]();
          }

          fnId = await actions.queryStringWithDefaults(
            "processing run request",
            queryKeys.FnId,
          );
          if (!fnId) {
            // TODO PrettyError
            throw new Error("No function ID found in async request");
          }

          fn = this.fns[fnId];

          stepId =
            (await actions.queryStringWithDefaults(
              "processing run request",
              queryKeys.StepId,
            )) || null;
        }

        if (typeof fnId === "undefined" || !fn) {
          throw new Error("No function ID found in request");
        }

        const { version, result } = this.runStep({
          functionId: fnId,
          data: body,
          stepId,
          timer,
          reqArgs,
          headers: await getHeaders(),
          fn,
          forceExecution,
          actions,
        });
        const stepOutput = await result;

        /**
         * Functions can return `undefined`, but we'll always convert this to
         * `null`, as this is appropriately serializable by JSON.
         */
        const opDataUndefinedToNull = (op: OutgoingOp) => {
          op.data = undefinedToNull(op.data);
          return op;
        };

        const resultHandlers: ExecutionResultHandlers<ActionResponse> = {
          "function-rejected": (result) => {
            return {
              status: result.retriable ? 500 : 400,
              headers: {
                "Content-Type": "application/json",
                [headerKeys.NoRetry]: result.retriable ? "false" : "true",
                ...(typeof result.retriable === "string"
                  ? { [headerKeys.RetryAfter]: result.retriable }
                  : {}),
              },
              body: stringify(undefinedToNull(result.error)),
              version,
            };
          },
          "function-resolved": (result) => {
            if (forceExecution) {
              const runCompleteOp: OutgoingOp = {
                id: _internals.hashId("complete"),
                op: StepOpCode.RunComplete,
                data: undefinedToNull(result.data),
              };

              return {
                status: 206,
                headers: {
                  "Content-Type": "application/json",
                },
                body: stringify(runCompleteOp),
                version,
              };
            }

            return {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
              body: stringify(undefinedToNull(result.data)),
              version,
            };
          },
          "step-not-found": (result) => {
            return {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                [headerKeys.NoRetry]: "false",
              },
              body: stringify({
                error: `Could not find step "${
                  result.step.displayName || result.step.id
                }" to run; timed out`,
              }),
              version,
            };
          },
          "step-ran": (result) => {
            const step = opDataUndefinedToNull(result.step);

            return {
              status: 206,
              headers: {
                "Content-Type": "application/json",
                ...(typeof result.retriable !== "undefined"
                  ? {
                      [headerKeys.NoRetry]: result.retriable ? "false" : "true",
                      ...(typeof result.retriable === "string"
                        ? { [headerKeys.RetryAfter]: result.retriable }
                        : {}),
                    }
                  : {}),
              },
              body: stringify([step]),
              version,
            };
          },
          "steps-found": (result) => {
            const steps = result.steps.map(opDataUndefinedToNull);

            return {
              status: 206,
              headers: {
                "Content-Type": "application/json",
              },
              body: stringify(steps),
              version,
            };
          },
          "change-mode": (result) => {
            return {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                [headerKeys.NoRetry]: "true",
              },
              body: stringify({
                error: `We wanted to change mode to "${result.to}", but this is not supported within the InngestCommHandler. This is a bug in the Inngest SDK.`,
              }),
              version,
            };
          },
        };

        const handler = resultHandlers[
          stepOutput.type
        ] as ExecutionResultHandler<ActionResponse>;

        try {
          return await handler(stepOutput);
        } catch (err) {
          this.log("error", "Error handling execution result", err);
          throw err;
        }
      }

      // TODO: This feels hacky, so we should probably make it not hacky.
      const env = (await getHeaders())[headerKeys.Environment] ?? null;

      if (method === "GET") {
        return {
          status: 200,
          body: stringify(
            await this.introspectionBody({
              actions,
              env,
              signatureValidation,
              url,
            }),
          ),
          headers: {
            "Content-Type": "application/json",
          },
          version: undefined,
        };
      }

      if (method === "PUT") {
        const [deployId, inBandSyncRequested] = await Promise.all([
          actions
            .queryStringWithDefaults(
              "processing deployment request",
              queryKeys.DeployId,
            )
            .then((deployId) => {
              return deployId === "undefined" ? undefined : deployId;
            }),

          Promise.resolve(
            parseAsBoolean(this.env[envKeys.InngestAllowInBandSync]),
          )
            .then((allowInBandSync) => {
              if (allowInBandSync !== undefined && !allowInBandSync) {
                return syncKind.OutOfBand;
              }

              return actions.headers(
                "processing deployment request",
                headerKeys.InngestSyncKind,
              );
            })
            .then((kind) => {
              return kind === syncKind.InBand;
            }),
        ]);

        if (inBandSyncRequested) {
          if (isMissingBody) {
            this.log(
              "error",
              "Missing body when syncing, possibly due to missing request body middleware",
            );

            return {
              status: 500,
              headers: {
                "Content-Type": "application/json",
              },
              body: stringify(
                serializeError(
                  new Error(
                    "Missing request body when syncing, possibly due to missing request body middleware",
                  ),
                ),
              ),
              version: undefined,
            };
          }

          // Validation can be successful if we're in dev mode and did not
          // actually validate a key. In this case, also check that we did indeed
          // use a particular key to validate.
          const sigCheck = await signatureValidation;

          if (!sigCheck.success) {
            return {
              status: 401,
              body: stringify({
                code: "sig_verification_failed",
              }),
              headers: {
                "Content-Type": "application/json",
              },
              version: undefined,
            };
          }

          const res = inBandSyncRequestBodySchema.safeParse(body);
          if (!res.success) {
            return {
              status: 400,
              body: stringify({
                code: "invalid_request",
                message: res.error.message,
              }),
              headers: {
                "Content-Type": "application/json",
              },
              version: undefined,
            };
          }

          // We can trust the URL here because it's coming from
          // signature-verified request.
          url = this.reqUrl(new URL(res.data.url));

          // This should be an in-band sync
          const respBody = await this.inBandRegisterBody({
            actions,
            deployId,
            env,
            signatureValidation,
            url,
          });

          return {
            status: 200,
            body: stringify(respBody),
            headers: {
              "Content-Type": "application/json",
              [headerKeys.InngestSyncKind]: syncKind.InBand,
            },
            version: undefined,
          };
        }

        // If we're here, this is a legacy out-of-band sync
        const { status, message, modified } = await this.register(
          this.reqUrl(url),
          deployId,
          getHeaders,
        );

        return {
          status,
          body: stringify({ message, modified }),
          headers: {
            "Content-Type": "application/json",
            [headerKeys.InngestSyncKind]: syncKind.OutOfBand,
          },
          version: undefined,
        };
      }
    } catch (err) {
      return {
        status: 500,
        body: stringify({
          type: "internal",
          ...serializeError(err as Error),
        }),
        headers: {
          "Content-Type": "application/json",
        },
        version: undefined,
      };
    }

    return {
      status: 405,
      body: JSON.stringify({
        message: "No action found; request was likely not POST, PUT, or GET",
        mode: this._mode,
      }),
      headers: {},
      version: undefined,
    };
  }

  protected runStep({
    actions,
    functionId,
    stepId,
    data,
    timer,
    reqArgs,
    headers,
    fn,
    forceExecution,
  }: {
    actions: HandlerResponseWithErrors;
    functionId: string;
    stepId: string | null;
    data: unknown;
    timer: ServerTiming;
    reqArgs: unknown[];
    headers: Record<string, string>;
    fn: { fn: InngestFunction.Any; onFailure: boolean };
    forceExecution: boolean;
  }): { version: ExecutionVersion; result: Promise<ExecutionResult> } {
    if (!fn) {
      // TODO PrettyError
      throw new Error(`Could not find function with ID "${functionId}"`);
    }

    const immediateFnData = parseFnData(data);
    let { version } = immediateFnData;

    // Handle opting in to optimized parallelism in v3.
    if (
      version === ExecutionVersion.V1 &&
      fn.fn["shouldOptimizeParallelism"]?.()
    ) {
      version = ExecutionVersion.V2;
    }

    const result = runAsPromise(async () => {
      const anyFnData = await fetchAllFnData({
        data: immediateFnData,
        api: this.client["inngestApi"],
        version,
      });

      if (!anyFnData.ok) {
        throw new Error(anyFnData.error);
      }

      type ExecutionStarter<V> = (
        fnData: V extends ExecutionVersion
          ? Extract<FnData, { version: V }>
          : FnData,
      ) => MaybePromise<CreateExecutionOptions>;

      type GenericExecutionStarters = Record<
        ExecutionVersion,
        ExecutionStarter<unknown>
      >;

      type ExecutionStarters = {
        [V in ExecutionVersion]: ExecutionStarter<V>;
      };

      const createResponse =
        forceExecution && actions.experimentalTransformSyncResponse
          ? (data: unknown) =>
              actions.experimentalTransformSyncResponse!(
                "created sync->async response",
                data,
              ).then((res) => ({
                ...res,
                version,
              }))
          : undefined;

      const executionStarters = ((s: ExecutionStarters) =>
        s as GenericExecutionStarters)({
        [ExecutionVersion.V0]: ({ event, events, steps, ctx, version }) => {
          const stepState = Object.entries(steps ?? {}).reduce<
            InngestExecutionOptions["stepState"]
          >((acc, [id, data]) => {
            return {
              ...acc,

              [id]: { id, data },
            };
          }, {});

          return {
            version,
            partialOptions: {
              client: this.client,
              runId: ctx?.run_id || "",
              stepMode: StepMode.Async,
              data: {
                event: event as EventPayload,
                events: events as [EventPayload, ...EventPayload[]],
                runId: ctx?.run_id || "",
                attempt: ctx?.attempt ?? 0,
              },
              stepState,
              requestedRunStep:
                stepId === "step" ? undefined : stepId || undefined,
              timer,
              isFailureHandler: fn.onFailure,
              stepCompletionOrder: ctx?.stack?.stack ?? [],
              reqArgs,
              headers,
              createResponse,
            },
          };
        },
        [ExecutionVersion.V1]: ({ event, events, steps, ctx, version }) => {
          const stepState = Object.entries(steps ?? {}).reduce<
            InngestExecutionOptions["stepState"]
          >((acc, [id, result]) => {
            return {
              ...acc,
              [id]:
                result.type === "data"
                  ? { id, data: result.data }
                  : result.type === "input"
                    ? { id, input: result.input }
                    : { id, error: result.error },
            };
          }, {});

          const requestedRunStep =
            stepId === "step" ? undefined : stepId || undefined;

          const checkpointingConfig = fn.fn["shouldAsyncCheckpoint"](
            requestedRunStep,
            ctx?.fn_id,
            Boolean(ctx?.disable_immediate_execution),
          );

          return {
            version,
            partialOptions: {
              client: this.client,
              runId: ctx?.run_id || "",
              stepMode: checkpointingConfig
                ? StepMode.AsyncCheckpointing
                : StepMode.Async,
              checkpointingConfig,
              data: {
                event: event as EventPayload,
                events: events as [EventPayload, ...EventPayload[]],
                runId: ctx?.run_id || "",
                attempt: ctx?.attempt ?? 0,
                maxAttempts: ctx?.max_attempts,
              },
              internalFnId: ctx?.fn_id,
              queueItemId: ctx?.qi_id,
              stepState,
              requestedRunStep,
              timer,
              isFailureHandler: fn.onFailure,
              disableImmediateExecution: ctx?.disable_immediate_execution,
              stepCompletionOrder: ctx?.stack?.stack ?? [],
              reqArgs,
              headers,
              createResponse,
            },
          };
        },
        [ExecutionVersion.V2]: ({ event, events, steps, ctx, version }) => {
          const stepState = Object.entries(steps ?? {}).reduce<
            InngestExecutionOptions["stepState"]
          >((acc, [id, result]) => {
            return {
              ...acc,
              [id]:
                result.type === "data"
                  ? { id, data: result.data }
                  : result.type === "input"
                    ? { id, input: result.input }
                    : { id, error: result.error },
            };
          }, {});

          const requestedRunStep =
            stepId === "step" ? undefined : stepId || undefined;

          const checkpointingConfig = fn.fn["shouldAsyncCheckpoint"](
            requestedRunStep,
            ctx?.fn_id,
            Boolean(ctx?.disable_immediate_execution),
          );

          return {
            version,
            partialOptions: {
              client: this.client,
              runId: ctx?.run_id || "",
              stepMode: checkpointingConfig
                ? StepMode.AsyncCheckpointing
                : StepMode.Async,
              checkpointingConfig,
              data: {
                event: event as EventPayload,
                events: events as [EventPayload, ...EventPayload[]],
                runId: ctx?.run_id || "",
                attempt: ctx?.attempt ?? 0,
                maxAttempts: ctx?.max_attempts,
              },
              internalFnId: ctx?.fn_id,
              queueItemId: ctx?.qi_id,
              stepState,
              requestedRunStep,
              timer,
              isFailureHandler: fn.onFailure,
              disableImmediateExecution: ctx?.disable_immediate_execution,
              stepCompletionOrder: ctx?.stack?.stack ?? [],
              reqArgs,
              headers,
              createResponse,
            },
          };
        },
      });

      const executionOptions = await executionStarters[version](
        anyFnData.value,
      );

      return fn.fn["createExecution"](executionOptions).start();
    });

    return { version, result };
  }

  protected configs(url: URL): FunctionConfig[] {
    const configs = Object.values(this.rawFns).reduce<FunctionConfig[]>(
      (acc, fn) => [
        ...acc,
        ...fn["getConfig"]({ baseUrl: url, appPrefix: this.id }),
      ],
      [],
    );

    for (const config of configs) {
      const check = functionConfigSchema.safeParse(config);
      if (!check.success) {
        const errors = check.error.errors.map((err) => err.message).join("; ");

        this.log(
          "warn",
          `Config invalid for function "${config.id}" : ${errors}`,
        );
      }
    }

    return configs;
  }

  /**
   * Return an Inngest serve endpoint URL given a potential `path` and `host`.
   *
   * Will automatically use the `serveHost` and `servePath` if they have been
   * set when registering.
   */
  protected reqUrl(url: URL): URL {
    let ret = new URL(url);

    const serveHost = this.serveHost || this.env[envKeys.InngestServeHost];
    const servePath = this.servePath || this.env[envKeys.InngestServePath];

    if (servePath) {
      ret.pathname = servePath;
    }

    if (serveHost) {
      ret = new URL(ret.pathname + ret.search, serveHost);
    }

    return ret;
  }

  protected registerBody({
    url,
    deployId,
  }: {
    url: URL;

    /**
     * Non-optional to ensure we always consider if we have a deploy ID
     * available to us to use.
     */
    deployId: string | undefined | null;
  }): RegisterRequest {
    const body: RegisterRequest = {
      url: url.href,
      deployType: "ping",
      framework: this.frameworkName,
      appName: this.id,
      functions: this.configs(url),
      sdk: `js:v${version}`,
      v: "0.1",
      deployId: deployId || undefined,
      capabilities: {
        trust_probe: "v1",
        connect: "v1",
      },
      appVersion: this.client.appVersion,
    };

    return body;
  }

  protected async inBandRegisterBody({
    actions,
    deployId,
    env,
    signatureValidation,
    url,
  }: {
    actions: HandlerResponseWithErrors;

    /**
     * Non-optional to ensure we always consider if we have a deploy ID
     * available to us to use.
     */
    deployId: string | undefined | null;

    env: string | null;
    signatureValidation: ReturnType<InngestCommHandler["validateSignature"]>;

    url: URL;
  }): Promise<InBandRegisterRequest> {
    const registerBody = this.registerBody({ deployId, url });
    const introspectionBody = await this.introspectionBody({
      actions,
      env,
      signatureValidation,
      url,
    });

    const body: InBandRegisterRequest = {
      app_id: this.id,
      appVersion: this.client.appVersion,
      capabilities: registerBody.capabilities,
      env,
      framework: registerBody.framework,
      functions: registerBody.functions,
      inspection: introspectionBody,
      platform: getPlatformName({
        ...allProcessEnv(),
        ...this.env,
      }),
      sdk_author: "inngest",
      sdk_language: "",
      sdk_version: "",
      sdk: registerBody.sdk,
      url: registerBody.url,
    };

    if (introspectionBody.authentication_succeeded) {
      body.sdk_language = introspectionBody.sdk_language;
      body.sdk_version = introspectionBody.sdk_version;
    }

    return body;
  }

  protected async introspectionBody({
    actions,
    env,
    signatureValidation,
    url,
  }: {
    actions: HandlerResponseWithErrors;
    env: string | null;
    signatureValidation: ReturnType<InngestCommHandler["validateSignature"]>;
    url: URL;
  }): Promise<UnauthenticatedIntrospection | AuthenticatedIntrospection> {
    const registerBody = this.registerBody({
      url: this.reqUrl(url),
      deployId: null,
    });

    if (!this._mode) {
      throw new Error("No mode set; cannot introspect without mode");
    }

    let introspection:
      | UnauthenticatedIntrospection
      | AuthenticatedIntrospection = {
      authentication_succeeded: null,
      extra: {
        is_mode_explicit: this._mode.isExplicit,
      },
      has_event_key: this.client["eventKeySet"](),
      has_signing_key: Boolean(this.signingKey),
      function_count: registerBody.functions.length,
      mode: this._mode.type,
      schema_version: "2024-05-24",
    } satisfies UnauthenticatedIntrospection;

    // Only allow authenticated introspection in Cloud mode, since Dev mode skips
    // signature validation
    if (this._mode.type === "cloud") {
      try {
        const validationResult = await signatureValidation;
        if (!validationResult.success) {
          throw new Error("Signature validation failed");
        }

        introspection = {
          ...introspection,
          authentication_succeeded: true,
          api_origin: this.apiBaseUrl,
          app_id: this.id,
          capabilities: {
            trust_probe: "v1",
            connect: "v1",
          },
          env,
          event_api_origin: this.eventApiBaseUrl,
          event_key_hash: this.hashedEventKey ?? null,
          extra: {
            ...introspection.extra,
            is_streaming: await this.shouldStream(actions),
          },
          framework: this.frameworkName,
          sdk_language: "js",
          sdk_version: version,
          serve_origin: this.serveHost ?? null,
          serve_path: this.servePath ?? null,
          signing_key_fallback_hash: this.hashedSigningKeyFallback ?? null,
          signing_key_hash: this.hashedSigningKey ?? null,
        } satisfies AuthenticatedIntrospection;
      } catch {
        // Swallow signature validation error since we'll just return the
        // unauthenticated introspection
        introspection = {
          ...introspection,
          authentication_succeeded: false,
        } satisfies UnauthenticatedIntrospection;
      }
    }

    return introspection;
  }

  protected async register(
    url: URL,
    deployId: string | undefined | null,
    getHeaders: () => Promise<Record<string, string>>,
  ): Promise<{ status: number; message: string; modified: boolean }> {
    const body = this.registerBody({ url, deployId });

    let res: globalThis.Response;

    // Whenever we register, we check to see if the dev server is up.  This
    // is a noop and returns false in production. Clone the URL object to avoid
    // mutating the property between requests.
    let registerURL = new URL(this.inngestRegisterUrl.href);

    const inferredDevMode =
      this._mode && this._mode.isInferred && this._mode.isDev;

    if (inferredDevMode) {
      const host = devServerHost(this.env);
      const hasDevServer = await devServerAvailable(host, this.fetch);
      if (hasDevServer) {
        registerURL = devServerUrl(host, "/fn/register");
      }
    } else if (this._mode?.explicitDevUrl) {
      registerURL = devServerUrl(
        this._mode.explicitDevUrl.href,
        "/fn/register",
      );
    }

    if (deployId) {
      registerURL.searchParams.set(queryKeys.DeployId, deployId);
    }

    try {
      res = await fetchWithAuthFallback({
        authToken: this.hashedSigningKey,
        authTokenFallback: this.hashedSigningKeyFallback,
        fetch: this.fetch,
        url: registerURL.href,
        options: {
          method: "POST",
          body: stringify(body),
          headers: {
            ...(await getHeaders()),
            [headerKeys.InngestSyncKind]: syncKind.OutOfBand,
          },
          redirect: "follow",
        },
      });
    } catch (err: unknown) {
      this.log("error", err);

      return {
        status: 500,
        message: `Failed to register${
          err instanceof Error ? `; ${err.message}` : ""
        }`,
        modified: false,
      };
    }

    const raw = await res.text();

    let data: z.input<typeof registerResSchema> = {};

    try {
      data = JSON.parse(raw);
    } catch (err) {
      this.log("warn", "Couldn't unpack register response:", err);

      let message = "Failed to register";
      if (err instanceof Error) {
        message += `; ${err.message}`;
      }
      message += `; status code: ${res.status}`;

      return {
        status: 500,
        message,
        modified: false,
      };
    }

    let status: number;
    let error: string;
    let skipped: boolean;
    let modified: boolean;
    try {
      ({ status, error, skipped, modified } = registerResSchema.parse(data));
    } catch (err) {
      this.log("warn", "Invalid register response schema:", err);

      let message = "Failed to register";
      if (err instanceof Error) {
        message += `; ${err.message}`;
      }
      message += `; status code: ${res.status}`;

      return {
        status: 500,
        message,
        modified: false,
      };
    }

    // The dev server polls this endpoint to register functions every few
    // seconds, but we only want to log that we've registered functions if
    // the function definitions change.  Therefore, we compare the body sent
    // during registration with the body of the current functions and refuse
    // to register if the functions are the same.
    if (!skipped) {
      this.log(
        "debug",
        "registered inngest functions:",
        res.status,
        res.statusText,
        data,
      );
    }

    return { status, message: error, modified };
  }

  /**
   * Given an environment, upsert any missing keys. This is useful in
   * situations where environment variables are passed directly to handlers or
   * are otherwise difficult to access during initialization.
   */
  private upsertKeysFromEnv() {
    if (this.env[envKeys.InngestSigningKey]) {
      if (!this.signingKey) {
        this.signingKey = String(this.env[envKeys.InngestSigningKey]);
      }

      this.client["inngestApi"].setSigningKey(this.signingKey);
    }

    if (this.env[envKeys.InngestSigningKeyFallback]) {
      if (!this.signingKeyFallback) {
        this.signingKeyFallback = String(
          this.env[envKeys.InngestSigningKeyFallback],
        );
      }

      this.client["inngestApi"].setSigningKeyFallback(this.signingKeyFallback);
    }

    if (!this.client["eventKeySet"]() && this.env[envKeys.InngestEventKey]) {
      this.client.setEventKey(String(this.env[envKeys.InngestEventKey]));
    }

    // v2 -> v3 migration warnings
    if (this.env[envKeys.InngestDevServerUrl]) {
      this.log(
        "warn",
        `Use of ${envKeys.InngestDevServerUrl} has been deprecated in v3; please use ${envKeys.InngestBaseUrl} instead. See https://www.inngest.com/docs/sdk/migration`,
      );
    }
  }

  /**
   * Validate the signature of a request and return the signing key used to
   * validate it.
   */

  protected async validateSignature(
    sig: string | undefined,
    body: unknown,
  ): Promise<
    { success: true; keyUsed: string } | { success: false; err: Error }
  > {
    try {
      // Skip signature validation if requested (used by connect)
      if (this.skipSignatureValidation) {
        return { success: true, keyUsed: "" };
      }

      // Never validate signatures outside of prod. Make sure to check the mode
      // exists here instead of using nullish coalescing to confirm that the check
      // has been completed.
      if (this._mode && !this._mode.isCloud) {
        return { success: true, keyUsed: "" };
      }

      // If we're here, we're in production; lack of a signing key is an error.
      if (!this.signingKey) {
        // TODO PrettyError
        throw new Error(
          `No signing key found in client options or ${envKeys.InngestSigningKey} env var. Find your keys at https://app.inngest.com/secrets`,
        );
      }

      // If we're here, we're in production; lack of a req signature is an error.
      if (!sig) {
        // TODO PrettyError
        throw new Error(`No ${headerKeys.Signature} provided`);
      }

      // Validate the signature
      return {
        success: true,
        keyUsed: new RequestSignature(sig).verifySignature({
          body,
          allowExpiredSignatures: this.allowExpiredSignatures,
          signingKey: this.signingKey,
          signingKeyFallback: this.signingKeyFallback,
        }),
      };
    } catch (err) {
      return { success: false, err: err as Error };
    }
  }

  protected getResponseSignature(key: string, body: string): string {
    const now = Date.now();
    const mac = signDataWithKey(body, key, now.toString());

    return `t=${now}&s=${mac}`;
  }

  /**
   * Log to stdout/stderr if the log level is set to include the given level.
   * The default log level is `"info"`.
   *
   * This is an abstraction over `console.log` and will try to use the correct
   * method for the given log level.  For example, `log("error", "foo")` will
   * call `console.error("foo")`.
   */
  protected log(level: LogLevel, ...args: unknown[]) {
    const logLevels: LogLevel[] = [
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
      "silent",
    ];

    const logLevelSetting = logLevels.indexOf(this.logLevel);
    const currentLevel = logLevels.indexOf(level);

    if (currentLevel >= logLevelSetting) {
      let logger = console.log;

      if (Object.hasOwn(console, level)) {
        logger = console[level as keyof typeof console] as typeof logger;
      }

      logger(`${logPrefix} ${level as string} -`, ...args);
    }
  }
}

class RequestSignature {
  public timestamp: string;
  public signature: string;

  constructor(sig: string) {
    const params = new URLSearchParams(sig);
    this.timestamp = params.get("t") || "";
    this.signature = params.get("s") || "";

    if (!this.timestamp || !this.signature) {
      // TODO PrettyError
      throw new Error(`Invalid ${headerKeys.Signature} provided`);
    }
  }

  private hasExpired(allowExpiredSignatures?: boolean) {
    if (allowExpiredSignatures) {
      return false;
    }

    const delta =
      Date.now() - new Date(Number.parseInt(this.timestamp) * 1000).valueOf();
    return delta > 1000 * 60 * 5;
  }

  #verifySignature({
    body,
    signingKey,
    allowExpiredSignatures,
  }: {
    body: unknown;
    signingKey: string;
    allowExpiredSignatures: boolean;
  }): void {
    if (this.hasExpired(allowExpiredSignatures)) {
      // TODO PrettyError
      throw new Error("Signature has expired");
    }

    const mac = signDataWithKey(body, signingKey, this.timestamp);
    if (mac !== this.signature) {
      // TODO PrettyError
      throw new Error("Invalid signature");
    }
  }

  public verifySignature({
    body,
    signingKey,
    signingKeyFallback,
    allowExpiredSignatures,
  }: {
    body: unknown;
    signingKey: string;
    signingKeyFallback: string | undefined;
    allowExpiredSignatures: boolean;
  }): string {
    try {
      this.#verifySignature({ body, signingKey, allowExpiredSignatures });

      return signingKey;
    } catch (err) {
      if (!signingKeyFallback) {
        throw err;
      }

      this.#verifySignature({
        body,
        signingKey: signingKeyFallback,
        allowExpiredSignatures,
      });

      return signingKeyFallback;
    }
  }
}

/**
 * The broad definition of a handler passed when instantiating an
 * {@link InngestCommHandler} instance.
 */
export type Handler<
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  Input extends any[] = any[],
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  Output = any,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  StreamOutput = any,
> = (...args: Input) => HandlerResponse<Output, StreamOutput>;

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export type HandlerResponse<Output = any, StreamOutput = any> = {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  body: () => MaybePromise<any>;
  textBody?: (() => MaybePromise<string>) | null; // TODO Make this required | null
  env?: () => MaybePromise<Env | undefined>;
  headers: (key: string) => MaybePromise<string | null | undefined>;

  /**
   * Whether the current environment is production. This is used to determine
   * some functionality like whether to connect to the dev server or whether to
   * show debug logging.
   *
   * If this is not provided--or is provided and returns `undefined`--we'll try
   * to automatically detect whether we're in production by checking various
   * environment variables.
   */
  isProduction?: () => MaybePromise<boolean | undefined>;
  method: () => MaybePromise<string>;
  queryString?: (
    key: string,
    url: URL,
  ) => MaybePromise<string | null | undefined>;
  url: () => MaybePromise<URL>;

  /**
   * The `transformResponse` function receives the output of the Inngest SDK and
   * can decide how to package up that information to appropriately return the
   * information to Inngest.
   *
   * Mostly, this is taking the given parameters and returning a new `Response`.
   *
   * The function is passed an {@link ActionResponse}, an object containing a
   * `status` code, a `headers` object, and a stringified `body`. This ensures
   * you can appropriately handle the response, including use of any required
   * parameters such as `res` in Express-/Connect-like frameworks.
   */
  transformResponse: (res: ActionResponse<string>) => Output;

  /**
   * The `transformStreamingResponse` function, if defined, declares that this
   * handler supports streaming responses back to Inngest. This is useful for
   * functions that are expected to take a long time, as edge streaming can
   * often circumvent restrictive request timeouts and other limitations.
   *
   * If your handler does not support streaming, do not define this function.
   *
   * It receives the output of the Inngest SDK and can decide how to package
   * up that information to appropriately return the information in a stream
   * to Inngest.
   *
   * Mostly, this is taking the given parameters and returning a new `Response`.
   *
   * The function is passed an {@link ActionResponse}, an object containing a
   * `status` code, a `headers` object, and `body`, a `ReadableStream`. This
   * ensures you can appropriately handle the response, including use of any
   * required parameters such as `res` in Express-/Connect-like frameworks.
   */
  transformStreamingResponse?: (
    res: ActionResponse<ReadableStream>,
  ) => StreamOutput;

  /**
   * TODO Needed to give folks a chance to wrap arguments if they need to in
   * order to extract the request body so that it can be sent back to Inngest
   * during either sync or async calls.
   *
   * This is because usually they do not interact directly with e.g. the
   * `Response` object, but with sync mode they do, so we need to provide hooks
   * to let us access the body.
   */
  experimentalTransformSyncRequest?: (
    ...args: unknown[]
  ) => MaybePromise<unknown>;

  /**
   * TODO Needed to give folks a chance to transform the response from their own
   * code to an Inngestish response. This is only needed so that sync mode can
   * checkpoint the response if we've gone through the entire run with no
   * interruptions.
   *
   * Because of its location when being specified, we have scoped access to the
   * `reqArgs` (e.g. `req` and `res`), so we don't need to pass them here.
   */
  experimentalTransformSyncResponse?: (
    data: unknown,
  ) => MaybePromise<Omit<ActionResponse, "version">>;
};

/**
 * The response from the Inngest SDK before it is transformed in to a
 * framework-compatible response by an {@link InngestCommHandler} instance.
 */
export interface ActionResponse<
  TBody extends string | ReadableStream = string,
> {
  /**
   * The HTTP status code to return.
   */
  status: number;

  /**
   * The headers to return in the response.
   */
  headers: Record<string, string>;

  /**
   * A stringified body to return.
   */
  body: TBody;

  /**
   * The version of the execution engine that was used to run this action.
   *
   * If the action didn't use the execution engine (for example, a GET request
   * as a health check) or would have but errored before reaching it, this will
   * be `undefined`.
   *
   * If the version should be entirely omitted from the response (for example,
   * when sending preliminary headers when streaming), this will be `null`.
   */
  version: ExecutionVersion | null | undefined;
}

/**
 * A version of {@link HandlerResponse} where each function is safely
 * promisified and requires a reason for each access.
 *
 * This enables us to provide accurate errors for each access without having to
 * wrap every access in a try/catch.
 */
export type ActionHandlerResponseWithErrors = {
  [K in keyof HandlerResponse]: NonNullable<HandlerResponse[K]> extends (
    ...args: infer Args
  ) => infer R
    ? R extends MaybePromise<infer PR>
      ? (errMessage: string, ...args: Args) => Promise<PR>
      : (errMessage: string, ...args: Args) => Promise<R>
    : HandlerResponse[K];
};

/**
 * A version of {@link ActionHandlerResponseWithErrors} that includes helper
 * functions that provide sensible defaults on top of the direct access given
 * from the bare response.
 */
export interface HandlerResponseWithErrors
  extends ActionHandlerResponseWithErrors {
  /**
   * Fetch a query string value from the request. If no `querystring` action has
   * been provided by the `serve()` handler, this will fall back to using the
   * provided URL present in the request to parse the query string from instead.
   */
  queryStringWithDefaults: (
    reason: string,
    key: string,
  ) => Promise<string | undefined>;
}
