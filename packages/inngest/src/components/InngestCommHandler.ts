import canonicalize from "canonicalize";
import debug from "debug";
import { hmac, sha256 } from "hash.js";
import { z } from "zod";
import { ServerTiming } from "../helpers/ServerTiming";
import {
  debugPrefix,
  defaultInngestBaseUrl,
  envKeys,
  headerKeys,
  logPrefix,
  queryKeys,
} from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import {
  allProcessEnv,
  devServerHost,
  getFetch,
  inngestHeaders,
  isProd,
  platformSupportsStreaming,
  skipDevServer,
  type Env,
} from "../helpers/env";
import { rethrowError, serializeError } from "../helpers/errors";
import { parseFnData } from "../helpers/functions";
import { runAsPromise } from "../helpers/promises";
import { createStream } from "../helpers/stream";
import { hashSigningKey, stringify } from "../helpers/strings";
import { type MaybePromise } from "../helpers/types";
import {
  logLevels,
  type FunctionConfig,
  type IntrospectRequest,
  type LogLevel,
  type RegisterOptions,
  type RegisterRequest,
  type SupportedFrameworkName,
} from "../types";
import { version } from "../version";
import { type AnyInngest } from "./Inngest";
import {
  type ExecutionResult,
  type ExecutionResultHandler,
  type ExecutionResultHandlers,
  type InngestExecutionOptions,
} from "./InngestExecution";
import {
  type AnyInngestFunction,
  type InngestFunction,
} from "./InngestFunction";

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
  client: AnyInngest;

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly AnyInngestFunction[];
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
  StreamOutput = any
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
  client: AnyInngest;

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly AnyInngestFunction[];

  /**
   * The `handler` is the function your framework requires to handle a
   * request. For example, this is most commonly a function that is given a
   * `Request` and must return a `Response`.
   *
   * The handler must map out any incoming parameters, then return a
   * strictly-typed object to assess what kind of request is being made,
   * collecting any relevant data as we go.
   *
   * @example
   * ```
   * return {
   *   register: () => { ... },
   *   run: () => { ... },
   *   view: () => { ... }
   * };
   * ```
   *
   * Every key must be specified and must be a function that either returns
   * a strictly-typed payload or `undefined` if the request is not for that
   * purpose.
   *
   * This gives handlers freedom to choose how their platform of choice will
   * trigger differing actions, whilst also ensuring all required information
   * is given for each request type.
   *
   * See any existing handler for a full example.
   *
   * This should never be defined by the user; a {@link ServeHandler} should
   * abstract this.
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
 * All handlers (Next.js, RedwoodJS, Remix, Deno Fresh, etc) are created using
 * this class; the exposed `serve` function will - most commonly - create an
 * instance of `InngestCommHandler` and then return `instance.createHandler()`.
 *
 * Two critical parameters required are the `handler` and the `transformRes`
 * function. See individual parameter details for more information, or see the
 * source code for an existing handler, e.g.
 * {@link https://github.com/inngest/inngest-js/blob/main/src/next.ts}
 *
 * @example
 * ```
 * // my-custom-handler.ts
 * import { InngestCommHandler, ServeHandler } from "inngest";
 *
 * export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
 *   const handler = new InngestCommHandler(
 *     "my-custom-handler",
 *     nameOrInngest,
 *     fns,
 *     opts,
 *     () => { ... },
 *     () => { ... }
 *   );
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
  StreamOutput = any
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
   * intentionally mutatble so that we can pick up the signing key from the
   * environment during execution if needed.
   */
  protected signingKey: string | undefined;

  /**
   * A property that can be set to indicate whether or not we believe we are in
   * production mode.
   *
   * Should be set every time a request is received.
   */
  protected _isProd = false;

  /**
   * Whether we should attempt to use the dev server.
   *
   * Should be set every time a request is received.
   */
  protected _skipDevServer = false;

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
   * when dealing with proxies/rediects).
   *
   * Provide the custom hostname here to ensure that the path is reported
   * correctly when registering functions with Inngest.
   *
   * To also provide a custom path, use `servePath`.
   */
  protected readonly serveHost: string | undefined;

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
  protected readonly servePath: string | undefined;

  /**
   * The minimum level to log from the Inngest serve handler.
   */
  protected readonly logLevel: LogLevel;

  protected readonly streaming: RegisterOptions["streaming"];

  /**
   * A private collection of just Inngest functions, as they have been passed
   * when instantiating the class.
   */
  private readonly rawFns: AnyInngestFunction[];

  private readonly client: AnyInngest;

  /**
   * A private collection of functions that are being served. This map is used
   * to find and register functions when interacting with Inngest Cloud.
   */
  private readonly fns: Record<
    string,
    { fn: InngestFunction; onFailure: boolean }
  > = {};

  private env: Env = allProcessEnv();

  private allowExpiredSignatures: boolean;

  constructor(options: InngestCommHandlerOptions<Input, Output, StreamOutput>) {
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
      Record<string, { fn: InngestFunction; onFailure: boolean }>
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

    this.inngestRegisterUrl = new URL(
      "/fn/register",
      options.baseUrl ||
        this.env[envKeys.InngestBaseUrl] ||
        this.client["baseUrl"] ||
        defaultInngestBaseUrl
    );

    this.signingKey = options.signingKey;
    this.serveHost = options.serveHost || this.env[envKeys.InngestServeHost];
    this.servePath = options.servePath || this.env[envKeys.InngestServePath];

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

    this.fetch = getFetch(options.fetch || this.client["fetch"]);
  }

  // hashedSigningKey creates a sha256 checksum of the signing key with the
  // same signing key prefix.
  private get hashedSigningKey(): string {
    return hashSigningKey(this.signingKey);
  }

  /**
   * `createHandler` should be used to return a type-equivalent version of the
   * `handler` specified during instantiation.
   *
   * @example
   * ```
   * // my-custom-handler.ts
   * import { InngestCommHandler, ServeHandler } from "inngest";
   *
   * export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
   *   const handler = new InngestCommHandler(
   *     "my-custom-handler",
   *     nameOrInngest,
   *     fns,
   *     opts,
   *     () => { ... },
   *     () => { ... }
   *   );
   *
   *   return handler.createHandler();
   * };
   * ```
   */
  public createHandler(): (...args: Input) => Promise<Awaited<Output>> {
    return async (...args: Input) => {
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
       * object where each function is safely promisifed with each access
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

      this.env =
        (await actions.env?.("starting to handle request")) ?? allProcessEnv();

      const getInngestHeaders = (): Record<string, string> =>
        inngestHeaders({
          env: this.env,
          framework: this.frameworkName,
          client: this.client,
          extras: {
            "Server-Timing": timer.getHeader(),
          },
        });

      const actionRes = timer.wrap("action", () =>
        this.handleAction(actions, timer, getInngestHeaders)
      );

      /**
       * Prepares an action response by merging returned data to provide
       * trailing information such as `Server-Timing` headers.
       *
       * It should always prioritize the headers returned by the action, as
       * they may contain important information such as `Content-Type`.
       */
      const prepareActionRes = (res: ActionResponse): ActionResponse => ({
        ...res,
        headers: {
          ...getInngestHeaders(),
          ...res.headers,
        },
      });

      const wantToStream =
        this.streaming === "force" ||
        (this.streaming === "allow" &&
          platformSupportsStreaming(
            this.frameworkName as SupportedFrameworkName,
            this.env
          ));

      if (wantToStream && actions.transformStreamingResponse) {
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
  private async handleAction(
    actions: HandlerResponseWithErrors,
    timer: ServerTiming,
    getInngestHeaders: () => Record<string, string>
  ): Promise<ActionResponse> {
    this._isProd =
      (await actions.isProduction?.("starting to handle request")) ??
      isProd(this.env);

    /**
     * If we've been explicitly passed an Inngest dev sever URL, assume that
     * we shouldn't skip the dev server.
     */
    this._skipDevServer = devServerHost(this.env)
      ? false
      : this._isProd ?? skipDevServer(this.env);

    this.upsertKeysFromEnv();

    try {
      const url = await actions.url("starting to handle request");
      const method = await actions.method("starting to handle request");

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
        const signature = await actions.headers(
          "checking signature for run request",
          headerKeys.Signature
        );

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const body = await actions.body("processing run request");
        this.validateSignature(signature ?? undefined, body);

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
              body: stringify(result.error),
            };
          },
          "function-resolved": (result) => {
            return {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
              body: stringify(result.data),
            };
          },
          "step-not-found": (_result) => {
            /**
             * TODO Status decision. I think we should use a unique op code for
             * this situation and keep the 206 status.
             */
            return {
              status: 999,
              headers: { "Content-Type": "application/json" },
              body: "",
            };
          },
          "step-ran": (result) => {
            return {
              status: 206,
              headers: { "Content-Type": "application/json" },
              body: stringify([result.step]),
            };
          },
          "steps-found": (result) => {
            return {
              status: 206,
              headers: { "Content-Type": "application/json" },
              body: stringify(result.steps),
            };
          },
        };

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

        const result = await this.runStep(fnId, stepId, body, timer);

        const handler = resultHandlers[
          result.type
        ] as ExecutionResultHandler<ActionResponse>;

        return await handler(result);
      }

      if (method === "GET") {
        const registerBody = this.registerBody(this.reqUrl(url));

        const introspection: IntrospectRequest = {
          message: "Inngest endpoint configured correctly.",
          hasEventKey: Boolean(this.client["eventKey"]),
          hasSigningKey: Boolean(this.signingKey),
          functionsFound: registerBody.functions.length,
        };

        return {
          status: 200,
          body: stringify(introspection),
          headers: {
            "Content-Type": "application/json",
          },
        };
      }

      if (method === "PUT") {
        const deployId = await getQuerystring(
          "processing deployment request",
          queryKeys.DeployId
        );

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
      };
    }

    return {
      status: 405,
      body: JSON.stringify({
        message: "No action found; request was likely not POST, PUT, or GET",
        isProd: this._isProd,
        skipDevServer: this._skipDevServer,
      }),
      headers: {},
    };
  }

  protected async runStep(
    functionId: string,
    stepId: string | null,
    data: unknown,
    timer: ServerTiming
  ): Promise<ExecutionResult> {
    const fn = this.fns[functionId];
    if (!fn) {
      // TODO PrettyError
      throw new Error(`Could not find function with ID "${functionId}"`);
    }

    const fndata = await parseFnData(data, this.client["inngestApi"]);
    if (!fndata.ok) {
      throw new Error(fndata.error);
    }
    const { event, events, steps, ctx } = fndata.value;

    const stepState = Object.entries(steps ?? {}).reduce<
      InngestExecutionOptions["stepState"]
    >((acc, [id, data]) => {
      return {
        ...acc,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        [id]: { id, data },
      };
    }, {});

    const execution = fn.fn["createExecution"]({
      data: { event, events, runId: ctx?.run_id, attempt: ctx?.attempt },
      stepState,
      requestedRunStep: stepId === "step" ? undefined : stepId || undefined,
      timer,
      isFailureHandler: fn.onFailure,
      disableImmediateExecution: fndata.value.ctx?.disable_immediate_execution,
      stepCompletionOrder: ctx?.stack?.stack ?? [],
    });

    return execution.start();
  }

  protected configs(url: URL): FunctionConfig[] {
    return Object.values(this.rawFns).reduce<FunctionConfig[]>(
      (acc, fn) => [...acc, ...fn["getConfig"](url, this.id)],
      []
    );
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

  protected registerBody(url: URL): RegisterRequest {
    const body: RegisterRequest = {
      url: url.href,
      deployType: "ping",
      framework: this.frameworkName,
      appName: this.id,
      functions: this.configs(url),
      sdk: `js:v${version}`,
      v: "0.1",
    };

    // Calculate the checksum of the body... without the checksum itself being included.
    body.hash = sha256().update(canonicalize(body)).digest("hex");
    return body;
  }

  protected async register(
    url: URL,
    deployId: string | undefined | null,
    getHeaders: () => Record<string, string>
  ): Promise<{ status: number; message: string; modified: boolean }> {
    const body = this.registerBody(url);

    let res: globalThis.Response;

    // Whenever we register, we check to see if the dev server is up.  This
    // is a noop and returns false in production.
    let registerURL = this.inngestRegisterUrl;

    if (!this._skipDevServer) {
      const host = devServerHost(this.env);
      const hasDevServer = await devServerAvailable(host, this.fetch);
      if (hasDevServer) {
        registerURL = devServerUrl(host, "/fn/register");
      }
    }

    if (deployId && deployId !== "undefined") {
      registerURL.searchParams.set(queryKeys.DeployId, deployId);
    }

    try {
      res = await this.fetch(registerURL.href, {
        method: "POST",
        body: stringify(body),
        headers: {
          ...getHeaders(),
          Authorization: `Bearer ${this.hashedSigningKey}`,
        },
        redirect: "follow",
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    let data: z.input<typeof registerResSchema> = {};

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data = await res.json();
    } catch (err) {
      this.log("warn", "Couldn't unpack register response:", err);
    }
    const { status, error, skipped, modified } = registerResSchema.parse(data);

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

  private get isProd() {
    return this._isProd;
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

    if (!this.client["eventKey"] && this.env[envKeys.InngestEventKey]) {
      this.client.setEventKey(String(this.env[envKeys.InngestEventKey]));
    }

    // v2 -> v3 migration warnings
    if (this.env[envKeys.InngestDevServerUrl]) {
      this.log(
        "warn",
        `Use of ${envKeys.InngestDevServerUrl} has been deprecated in v3; please use ${envKeys.InngestBaseUrl} instead. See https://www.inngest.com/docs/sdk/migration`
      );
    }

    if (this.env[envKeys.InngestApiBaseUrl]) {
      this.log(
        "warn",
        `Use of ${envKeys.InngestApiBaseUrl} has been deprecated in v3; please use ${envKeys.InngestBaseUrl} instead. See https://www.inngest.com/docs/sdk/migration`
      );
    }
  }

  protected validateSignature(sig: string | undefined, body: unknown) {
    // Never validate signatures in development.
    if (!this.isProd) {
      // In dev, warning users about signing keys ensures that it's considered
      if (!this.signingKey) {
        // TODO PrettyError
        console.warn(
          "No signing key provided to validate signature. Find your dev keys at https://app.inngest.com/test/secrets"
        );
      }

      return;
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
    new RequestSignature(sig).verifySignature({
      body,
      allowExpiredSignatures: this.allowExpiredSignatures,
      signingKey: this.signingKey,
    });
  }

  protected signResponse(): string {
    return "";
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

  public verifySignature({
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

    // Calculate the HMAC of the request body ourselves.
    // We make the assumption here that a stringified body is the same as the
    // raw bytes; it may be pertinent in the future to always parse, then
    // canonicalize the body to ensure it's consistent.
    const encoded = typeof body === "string" ? body : canonicalize(body);
    // Remove the /signkey-[test|prod]-/ prefix from our signing key to calculate the HMAC.
    const key = signingKey.replace(/signkey-\w+-/, "");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    const mac = hmac(sha256 as any, key)
      .update(encoded)
      .update(this.timestamp)
      .digest("hex");

    if (mac !== this.signature) {
      // TODO PrettyError
      throw new Error("Invalid signature");
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
  StreamOutput = any
> = (...args: Input) => HandlerResponse<Output, StreamOutput>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerResponse<Output = any, StreamOutput = any> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: () => MaybePromise<any>;
  env?: () => MaybePromise<Env>;
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
  TBody extends string | ReadableStream = string
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
}

/**
 * A version of {@link HandlerResponse} where each function is safely
 * promisified and requires a reason for each access.
 *
 * This enables us to provide accurate errors for each access without having to
 * wrap every access in a try/catch.
 */
type HandlerResponseWithErrors = {
  [K in keyof HandlerResponse]: NonNullable<HandlerResponse[K]> extends (
    ...args: infer Args
  ) => infer R
    ? R extends MaybePromise<infer PR>
      ? (errMessage: string, ...args: Args) => Promise<PR>
      : (errMessage: string, ...args: Args) => Promise<R>
    : HandlerResponse[K];
};
