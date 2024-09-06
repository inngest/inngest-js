import debug from "debug";
import { z } from "zod";
import { ServerTiming } from "../helpers/ServerTiming";
import {
  debugPrefix,
  defaultInngestApiBaseUrl,
  defaultInngestEventBaseUrl,
  dummyEventKey,
  envKeys,
  headerKeys,
  logPrefix,
  probe as probeEnum,
  queryKeys,
} from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import { enumFromValue } from "../helpers/enum";
import {
  Mode,
  allProcessEnv,
  devServerHost,
  getFetch,
  getMode,
  inngestHeaders,
  platformSupportsStreaming,
  type Env,
} from "../helpers/env";
import { rethrowError, serializeError } from "../helpers/errors";
import {
  fetchAllFnData,
  parseFnData,
  undefinedToNull,
  type FnData,
} from "../helpers/functions";
import { fetchWithAuthFallback, signDataWithKey } from "../helpers/net";
import { runAsPromise } from "../helpers/promises";
import { createStream } from "../helpers/stream";
import { hashEventKey, hashSigningKey, stringify } from "../helpers/strings";
import { type MaybePromise } from "../helpers/types";
import {
  functionConfigSchema,
  logLevels,
  type AuthenticatedIntrospection,
  type EventPayload,
  type FunctionConfig,
  type LogLevel,
  type OutgoingOp,
  type RegisterOptions,
  type RegisterRequest,
  type SupportedFrameworkName,
  type UnauthenticatedIntrospection,
} from "../types";
import { version } from "../version";
import { type Inngest } from "./Inngest";
import {
  type CreateExecutionOptions,
  type InngestFunction,
} from "./InngestFunction";
import {
  ExecutionVersion,
  PREFERRED_EXECUTION_VERSION,
  type ExecutionResult,
  type ExecutionResultHandler,
  type ExecutionResultHandlers,
  type InngestExecutionOptions,
} from "./execution/InngestExecution";

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
  client: Inngest.Any;

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly InngestFunction.Any[];
}

export interface InternalServeHandlerOptions extends ServeHandlerOptions {
  /**
   * Can be used to override the framework name given to a particular serve
   * handler.
   */
  frameworkName?: string;
}

interface InngestCommHandlerOptions<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Input extends any[] = any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Output = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  client: Inngest.Any;

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly InngestFunction.Any[];

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Input extends any[] = any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Output = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    if (Object.prototype.hasOwnProperty.call(options, "eventKey")) {
      throw new Error(
        `${logPrefix} You've passed an Inngest client as the first argument to your serve handler. This is no longer supported in v3; please pass the Inngest client as the \`client\` property of an options object instead. See https://www.inngest.com/docs/sdk/migration`
      );
    }

    this.frameworkName = options.frameworkName;
    this.client = options.client;
    this.id = options.id || this.client.id;

    this.handler = options.handler as Handler;

    /**
     * Provide a hidden option to allow expired signatures to be accepted during
     * testing.
     */
    this.allowExpiredSignatures = Boolean(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, prefer-rest-params
      arguments["0"]?.__testingAllowExpiredSignatures
    );

    // Ensure we filter any undefined functions in case of missing imports.
    this.rawFns = options.functions.filter(Boolean);

    if (this.rawFns.length !== options.functions.length) {
      // TODO PrettyError
      console.warn(
        `Some functions passed to serve() are undefined and misconfigured.  Please check your imports.`
      );
    }

    this.fns = this.rawFns.reduce<
      Record<string, { fn: InngestFunction.Any; onFailure: boolean }>
    >((acc, fn) => {
      const configs = fn["getConfig"](new URL("https://example.com"), this.id);

      const fns = configs.reduce((acc, { id }, index) => {
        return { ...acc, [id]: { fn, onFailure: Boolean(index) } };
      }, {});

      configs.forEach(({ id }) => {
        if (acc[id]) {
          // TODO PrettyError
          throw new Error(
            `Duplicate function ID "${id}"; please change a function's name or provide an explicit ID to avoid conflicts.`
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

    const defaultLogLevel: typeof this.logLevel = "info";
    this.logLevel = z
      .enum(logLevels)
      .default(defaultLogLevel)
      .catch((ctx) => {
        this.log(
          "warn",
          `Unknown log level passed: ${String(
            ctx.input
          )}; defaulting to ${defaultLogLevel}`
        );

        return defaultLogLevel;
      })
      .parse(options.logLevel || this.env[envKeys.InngestLogLevel]);

    if (this.logLevel === "debug") {
      debug.enable(`${debugPrefix}:*`);
    }

    const defaultStreamingOption: typeof this.streaming = false;
    this.streaming = z
      .union([z.enum(["allow", "force"]), z.literal(false)])
      .default(defaultStreamingOption)
      .catch((ctx) => {
        this.log(
          "warn",
          `Unknown streaming option passed: ${String(
            ctx.input
          )}; defaulting to ${String(defaultStreamingOption)}`
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
  private shouldStream(actions: HandlerResponseWithErrors): boolean {
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
        this.env
      )
    );
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
  public createHandler(): (...args: Input) => Promise<Awaited<Output>> {
    const handler = async (...args: Input) => {
      const timer = new ServerTiming();

      /**
       * We purposefully `await` the handler, as it could be either sync or
       * async.
       */
      const rawActions = await timer
        .wrap("handler", () => this.handler(...args))
        .catch(rethrowError("Serve handler failed to run"));

      /**
       * Map over every `action` in `rawActions` and create a new `actions`
       * object where each function is safely promisified with each access
       * requiring a reason.
       *
       * This helps us provide high quality errors about what's going wrong for
       * each access without having to wrap every access in a try/catch.
       */
      const actions: HandlerResponseWithErrors = Object.entries(
        rawActions
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

            const fn = () =>
              (value as (...args: unknown[]) => unknown)(...args);

            return runAsPromise(fn)
              .catch(rethrowError(errMessage))
              .catch((err) => {
                this.log("error", err);
                throw err;
              });
          },
        };
      }, {} as HandlerResponseWithErrors);

      const [env, expectedServerKind] = await Promise.all([
        actions.env?.("starting to handle request"),
        actions.headers(
          "checking expected server kind",
          headerKeys.InngestServerKind
        ),
      ]);

      // Always make sure to merge whatever env we've been given with
      // `process.env`; some platforms may not provide all the necessary
      // environment variables or may use two sources.
      this.env = {
        ...allProcessEnv(),
        ...env,
      };

      const getInngestHeaders = (): Record<string, string> =>
        inngestHeaders({
          env: this.env,
          framework: this.frameworkName,
          client: this.client,
          expectedServerKind: expectedServerKind || undefined,
          extras: {
            "Server-Timing": timer.getHeader(),
          },
        });

      const assumedMode = getMode({ env: this.env, client: this.client });

      if (assumedMode.isExplicit) {
        this._mode = assumedMode;
      } else {
        const serveIsProd = await actions.isProduction?.(
          "starting to handle request"
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

      const methodP = actions.method("starting to handle request");

      const headerPromises = [
        headerKeys.TraceParent,
        headerKeys.TraceState,
      ].map(async (header) => {
        const value = await actions.headers(
          `fetching ${header} for forwarding`,
          header
        );

        return { header, value };
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const [signature, method, body] = await Promise.all([
        actions
          .headers("checking signature for request", headerKeys.Signature)
          .then((headerSignature) => {
            return headerSignature ?? undefined;
          }),
        methodP,
        methodP.then((method) => {
          if (method === "POST") {
            return actions.body(
              `checking body for request signing as method is ${method}`
            );
          }

          return "";
        }),
      ]);

      const signatureValidation = this.validateSignature(signature, body);

      const headersToForwardP = Promise.all(headerPromises).then(
        (fetchedHeaders) => {
          return fetchedHeaders.reduce<Record<string, string>>(
            (acc, { header, value }) => {
              if (value) {
                acc[header] = value;
              }

              return acc;
            },
            {}
          );
        }
      );

      const actionRes = timer.wrap("action", () =>
        this.handleAction({
          actions,
          timer,
          getInngestHeaders,
          reqArgs: args,
          signatureValidation,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          body,
          method,
          headers: headersToForwardP,
        })
      );

      /**
       * Prepares an action response by merging returned data to provide
       * trailing information such as `Server-Timing` headers.
       *
       * It should always prioritize the headers returned by the action, as they
       * may contain important information such as `Content-Type`.
       */
      const prepareActionRes = async (
        res: ActionResponse
      ): Promise<ActionResponse> => {
        const signature = await signatureValidation
          .then((result) => {
            if (!result.success || !result.keyUsed) {
              return undefined;
            }

            return this.getResponseSignature(result.keyUsed, res.body);
          })
          .catch((_err) => {
            // no-op; only sign responses if we have successfully validated the
            // request
            return undefined;
          });

        return {
          ...res,
          headers: {
            ...getInngestHeaders(),
            ...(await headersToForwardP),
            ...res.headers,
            ...(res.version === null
              ? {}
              : {
                  [headerKeys.RequestVersion]: (
                    res.version ?? PREFERRED_EXECUTION_VERSION
                  ).toString(),
                }),
            ...(signature ? { [headerKeys.Signature]: signature } : {}),
          },
        };
      };

      if (this.shouldStream(actions)) {
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

          return timer.wrap("res", () => {
            return actions.transformStreamingResponse?.(
              "starting streaming response",
              {
                status: 201,
                headers: getInngestHeaders(),
                body: stream,
                version: null,
              }
            );
          });
        }
      }

      return timer.wrap("res", async () => {
        return actionRes.then(prepareActionRes).then((actionRes) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return actions.transformResponse("sending back response", actionRes);
        });
      });
    };

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

  private get mode(): Mode | undefined {
    return this._mode;
  }

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
    getInngestHeaders,
    reqArgs,
    signatureValidation,
    body,
    method,
    headers,
  }: {
    actions: HandlerResponseWithErrors;
    timer: ServerTiming;
    getInngestHeaders: () => Record<string, string>;
    reqArgs: unknown[];
    signatureValidation: ReturnType<InngestCommHandler["validateSignature"]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: any;
    method: string;
    headers: Promise<Record<string, string>>;
  }): Promise<ActionResponse> {
    try {
      const url = await actions.url("starting to handle request");

      const getQuerystring = async (
        reason: string,
        key: string
      ): Promise<string | undefined> => {
        const ret =
          (await actions.queryString?.(reason, key, url)) ||
          url.searchParams.get(key) ||
          undefined;

        return ret;
      };

      if (method === "POST") {
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

        const rawProbe = await getQuerystring(
          "testing for probe",
          queryKeys.Probe
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
                serializeError(new Error(`Unknown probe "${rawProbe}"`))
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

        const fnId = await getQuerystring(
          "processing run request",
          queryKeys.FnId
        );
        if (!fnId) {
          // TODO PrettyError
          throw new Error("No function ID found in request");
        }

        const stepId =
          (await getQuerystring("processing run request", queryKeys.StepId)) ||
          null;

        const { version, result } = this.runStep({
          functionId: fnId,
          data: body,
          stepId,
          timer,
          reqArgs,
          headers: await headers,
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
              status: 206,
              headers: {
                "Content-Type": "application/json",
                [headerKeys.NoRetry]: "false",
              },
              body: stringify([result.step]),
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

      if (method === "GET") {
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
              app_id: this.client.id,
              capabilities: {
                trust_probe: "v1",
              },
              env:
                (await actions.headers(
                  "fetching environment for introspection request",
                  headerKeys.Environment
                )) || null,
              event_api_origin: this.eventApiBaseUrl,
              event_key_hash: this.hashedEventKey ?? null,
              extra: {
                ...introspection.extra,
                is_streaming: this.shouldStream(actions),
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

        return {
          status: 200,
          body: stringify(introspection),
          headers: {
            "Content-Type": "application/json",
          },
          version: undefined,
        };
      }

      if (method === "PUT") {
        let deployId = await getQuerystring(
          "processing deployment request",
          queryKeys.DeployId
        );
        if (deployId === "undefined") {
          deployId = undefined;
        }

        const { status, message, modified } = await this.register(
          this.reqUrl(url),
          deployId,
          getInngestHeaders
        );

        return {
          status,
          body: stringify({ message, modified }),
          headers: {
            "Content-Type": "application/json",
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
    functionId,
    stepId,
    data,
    timer,
    reqArgs,
    headers,
  }: {
    functionId: string;
    stepId: string | null;
    data: unknown;
    timer: ServerTiming;
    reqArgs: unknown[];
    headers: Record<string, string>;
  }): { version: ExecutionVersion; result: Promise<ExecutionResult> } {
    const fn = this.fns[functionId];
    if (!fn) {
      // TODO PrettyError
      throw new Error(`Could not find function with ID "${functionId}"`);
    }

    const immediateFnData = parseFnData(fn.fn, data);
    const { version } = immediateFnData;

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
          : FnData
      ) => MaybePromise<CreateExecutionOptions>;

      type GenericExecutionStarters = Record<
        ExecutionVersion,
        ExecutionStarter<unknown>
      >;

      type ExecutionStarters = {
        [V in ExecutionVersion]: ExecutionStarter<V>;
      };

      const executionStarters = ((s: ExecutionStarters) =>
        s as GenericExecutionStarters)({
        [ExecutionVersion.V0]: ({ event, events, steps, ctx, version }) => {
          const stepState = Object.entries(steps ?? {}).reduce<
            InngestExecutionOptions["stepState"]
          >((acc, [id, data]) => {
            return {
              ...acc,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              [id]: { id, data },
            };
          }, {});

          return {
            version,
            partialOptions: {
              runId: ctx?.run_id || "",
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
                  ? // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                    { id, data: result.data }
                  : { id, error: result.error },
            };
          }, {});

          return {
            version,
            partialOptions: {
              runId: ctx?.run_id || "",
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
              disableImmediateExecution: ctx?.disable_immediate_execution,
              stepCompletionOrder: ctx?.stack?.stack ?? [],
              reqArgs,
              headers,
            },
          };
        },
      });

      const executionOptions = await executionStarters[anyFnData.value.version](
        anyFnData.value
      );

      return fn.fn["createExecution"](executionOptions).start();
    });

    return { version, result };
  }

  protected configs(url: URL): FunctionConfig[] {
    const configs = Object.values(this.rawFns).reduce<FunctionConfig[]>(
      (acc, fn) => [...acc, ...fn["getConfig"](url, this.id)],
      []
    );

    for (const config of configs) {
      const check = functionConfigSchema.safeParse(config);
      if (!check.success) {
        const errors = check.error.errors.map((err) => err.message).join("; ");

        this.log(
          "warn",
          `Config invalid for function "${config.id}" : ${errors}`
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
      },
    };

    return body;
  }

  protected async register(
    url: URL,
    deployId: string | undefined | null,
    getHeaders: () => Record<string, string>
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
        "/fn/register"
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
          headers: getHeaders(),
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    let data: z.input<typeof registerResSchema> = {};

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
        data
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
          this.env[envKeys.InngestSigningKeyFallback]
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
        `Use of ${envKeys.InngestDevServerUrl} has been deprecated in v3; please use ${envKeys.InngestBaseUrl} instead. See https://www.inngest.com/docs/sdk/migration`
      );
    }
  }

  /**
   * Validate the signature of a request and return the signing key used to
   * validate it.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  protected async validateSignature(
    sig: string | undefined,
    body: unknown
  ): Promise<
    { success: true; keyUsed: string } | { success: false; err: Error }
  > {
    try {
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
          `No signing key found in client options or ${envKeys.InngestSigningKey} env var. Find your keys at https://app.inngest.com/secrets`
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

      if (Object.prototype.hasOwnProperty.call(console, level)) {
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
      Date.now() - new Date(parseInt(this.timestamp) * 1000).valueOf();
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Input extends any[] = any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Output = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StreamOutput = any,
> = (...args: Input) => HandlerResponse<Output, StreamOutput>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerResponse<Output = any, StreamOutput = any> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: () => MaybePromise<any>;
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
    url: URL
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
    res: ActionResponse<ReadableStream>
  ) => StreamOutput;
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
   * as a health check), this will be `undefined`.
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
export type HandlerResponseWithErrors = {
  [K in keyof HandlerResponse]: NonNullable<HandlerResponse[K]> extends (
    ...args: infer Args
  ) => infer R
    ? R extends MaybePromise<infer PR>
      ? (errMessage: string, ...args: Args) => Promise<PR>
      : (errMessage: string, ...args: Args) => Promise<R>
    : HandlerResponse[K];
};
