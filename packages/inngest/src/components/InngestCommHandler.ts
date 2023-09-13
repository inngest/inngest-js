import canonicalize from "canonicalize";
import { hmac, sha256 } from "hash.js";
import { z } from "zod";
import { ServerTiming } from "../helpers/ServerTiming";
import { envKeys, headerKeys, queryKeys } from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import {
  allProcessEnv,
  devServerHost,
  getFetch,
  inngestHeaders,
  isProd,
  platformSupportsStreaming,
  skipDevServer,
} from "../helpers/env";
import { OutgoingResultError, serializeError } from "../helpers/errors";
import { cacheFn, parseFnData } from "../helpers/functions";
import { createStream } from "../helpers/stream";
import {
  hashSigningKey,
  stringify,
  stringifyUnknown,
} from "../helpers/strings";
import { type MaybePromise } from "../helpers/types";
import {
  type FunctionConfig,
  type IncomingOp,
  type InternalRegisterOptions,
  type IntrospectRequest,
  type LogLevel,
  type RegisterOptions,
  type RegisterRequest,
  type StepRunResponse,
  type SupportedFrameworkName,
} from "../types";
import { version } from "../version";
import { type Inngest } from "./Inngest";
import { type InngestFunction } from "./InngestFunction";
import { NonRetriableError } from "./NonRetriableError";

/**
 * A handler for serving Inngest functions. This type should be used
 * whenever a handler for a new framework is being added to enforce that the
 * registration process is always the same for the user.
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
export type ServeHandler = (
  /**
   * The name of this app, used to scope and group Inngest functions, or
   * the `Inngest` instance used to declare all functions.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: Inngest<any>,

  /**
   * An array of the functions to serve and register with Inngest.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  functions: InngestFunction<any, any, any, any>[],

  /**
   * A set of options to further configure the registration of Inngest
   * functions.
   */
  opts?: RegisterOptions
  /**
   * This `any` return is appropriate.
   *
   * While we can infer the signature of the returned value, we cannot guarantee
   * that we have used the same types as the framework we are integrating with,
   * which sometimes can cause frustrating collisions for a user that result in
   * `as unknown as X` casts.
   *
   * Instead, we will use `any` here and have the user be able to place it
   * anywhere they need.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => any;

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
  H extends Handler,
  TResTransform extends (
    res: ActionResponse<string>,
    ...args: Parameters<H>
  ) => // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  TStreamTransform extends (
    res: ActionResponse<ReadableStream>,
    ...args: Parameters<H>
  ) => // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
> {
  /**
   * The name of this serve handler, e.g. `"My App"`. It's recommended that this
   * value represents the overarching app/service that this set of functions is
   * being served from.
   */
  public readonly name: string;

  /**
   * The handler specified during instantiation of the class.
   */
  public readonly handler: H;

  /**
   * The response transformer specified during instantiation of the class.
   */
  public readonly transformRes: TResTransform;

  public readonly streamTransformRes: TStreamTransform | undefined;

  /**
   * The URL of the Inngest function registration endpoint.
   */
  private readonly inngestRegisterUrl: URL;

  /**
   * The name of the framework this handler is designed for. Should be
   * lowercase, alphanumeric characters inclusive of `-` and `/`. This should
   * never be defined by the user; a {@link ServeHandler} should abstract this.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly rawFns: InngestFunction<any, any, any, any>[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: Inngest<any>;

  /**
   * A private collection of functions that are being served. This map is used
   * to find and register functions when interacting with Inngest Cloud.
   */
  private readonly fns: Record<
    string,
    { fn: InngestFunction; onFailure: boolean }
  > = {};

  private allowExpiredSignatures: boolean;

  constructor(
    /**
     * The name of the framework this handler is designed for. Should be
     * lowercase, alphanumeric characters inclusive of `-` and `/`.
     *
     * This should never be defined by the user; a {@link ServeHandler} should
     * abstract this.
     */
    frameworkName: string,

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: Inngest<any>,

    /**
     * An array of the functions to serve and register with Inngest.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    functions: InngestFunction<any, any, any, any>[],
    options: RegisterOptions = {},

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
    handler: H,

    /**
     * The `transformRes` function receives the output of the Inngest SDK and
     * can decide how to package up that information to appropriately return the
     * information to Inngest.
     *
     * Mostly, this is taking the given parameters and returning a new
     * `Response`.
     *
     * The function is passed an {@link ActionResponse} (an object containing a
     * `status` code, a `headers` object, and a stringified `body`), as well as
     * every parameter passed to the given `handler` function. This ensures you
     * can appropriately handle the response, including use of any required
     * parameters such as `res` in Express-/Connect-like frameworks.
     *
     * This should never be defined by the user; a {@link ServeHandler} should
     * abstract this.
     */
    transformRes: TResTransform,

    /**
     * The `streamTransformRes` function, if defined, declares that this handler
     * supports streaming responses back to Inngest. This is useful for
     * functions that are expected to take a long time, as edge streaming can
     * often circumvent restrictive request timeouts and other limitations.
     *
     * If your handler does not support streaming, do not define this function.
     *
     * It receives the output of the Inngest SDK and can decide how to package
     * up that information to appropriately return the information in a stream
     * to Inngest.
     *
     * Mostly, this is taking the given parameters and returning a new
     * `Response`.
     *
     * The function is passed an {@link ActionResponse} (an object containing a
     * `status` code, a `headers` object, and `body`, a `ReadableStream`), as
     * well as every parameter passed to the given `handler` function. This
     * ensures you can appropriately handle the response, including use of any
     * required parameters such as `res` in Express-/Connect-like frameworks.
     *
     * This should never be defined by the user; a {@link ServeHandler} should
     * abstract this.
     */
    streamTransformRes?: TStreamTransform
  ) {
    this.frameworkName =
      (options as InternalRegisterOptions)?.frameworkName || frameworkName;
    this.client = client;
    this.name = options.name || this.client.name;

    this.handler = handler;
    this.transformRes = transformRes;
    this.streamTransformRes = streamTransformRes;

    /**
     * Provide a hidden option to allow expired signatures to be accepted during
     * testing.
     */
    this.allowExpiredSignatures = Boolean(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, prefer-rest-params
      arguments["3"]?.__testingAllowExpiredSignatures
    );

    // Ensure we filter any undefined functions in case of missing imports.
    this.rawFns = functions.filter(Boolean);

    if (this.rawFns.length !== functions.length) {
      // TODO PrettyError
      console.warn(
        `Some functions passed to serve() are undefined and misconfigured.  Please check your imports.`
      );
    }

    this.fns = this.rawFns.reduce<
      Record<string, { fn: InngestFunction; onFailure: boolean }>
    >((acc, fn) => {
      const configs = fn["getConfig"](
        new URL("https://example.com"),
        this.name
      );

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
      options.inngestRegisterUrl || "https://api.inngest.com/fn/register"
    );

    this.signingKey = options.signingKey;
    this.serveHost = options.serveHost;
    this.servePath = options.servePath;
    this.logLevel = options.logLevel ?? "info";
    this.streaming = options.streaming ?? false;

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
  public createHandler(): (
    ...args: Parameters<H>
  ) => Promise<Awaited<ReturnType<TResTransform>>> {
    return async (...args: Parameters<H>) => {
      const timer = new ServerTiming();

      /**
       * We purposefully `await` the handler, as it could be either sync or
       * async.
       */
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const rawActions = await timer.wrap("handler", () =>
        this.handler(...args)
      );

      /**
       * For each function within the actions returned, ensure that its value
       * caches when run. This ensures that the function is only run once, even
       * if it's called multiple times throughout this handler's invocation.
       *
       * Many frameworks have issues with multiple calls to req/res objects;
       * reading a request's body multiple times is a common example. This makes
       * sure to handle this without having to pass around references.
       */
      const actions = Object.fromEntries(
        Object.entries(rawActions).map(([key, val]) => [
          key,
          typeof val === "function" ? cacheFn(val) : val,
        ])
      ) as typeof rawActions;

      const getHeaders = (): Record<string, string> =>
        inngestHeaders({
          env: actions.env as Record<string, string | undefined>,
          framework: this.frameworkName,
          client: this.client,
          extras: {
            "Server-Timing": timer.getHeader(),
          },
        });

      const actionRes = timer.wrap("action", () =>
        this.handleAction(actions as ReturnType<Awaited<H>>, timer)
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
          ...getHeaders(),
          ...res.headers,
        },
      });

      const wantToStream =
        this.streaming === "force" ||
        (this.streaming === "allow" &&
          platformSupportsStreaming(
            this.frameworkName as SupportedFrameworkName,
            actions.env as Record<string, string | undefined>
          ));

      if (wantToStream && this.streamTransformRes) {
        const runRes = await actions.run();
        if (runRes) {
          const { stream, finalize } = await createStream();

          /**
           * Errors are handled by `handleAction` here to ensure that an
           * appropriate response is always given.
           */
          void actionRes.then((res) => finalize(prepareActionRes(res)));

          return timer.wrap("res", () =>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            this.streamTransformRes?.(
              {
                status: 201,
                headers: getHeaders(),
                body: stream,
              },
              ...args
            )
          );
        }
      }

      return timer.wrap("res", async () => {
        return actionRes.then((res) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return this.transformRes(prepareActionRes(res), ...args);
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
    actions: ReturnType<H>,
    timer: ServerTiming
  ): Promise<ActionResponse> {
    const env = actions.env ?? allProcessEnv();

    const getHeaders = (): Record<string, string> =>
      inngestHeaders({
        env: env as Record<string, string | undefined>,
        framework: this.frameworkName,
        client: this.client,
        extras: {
          "Server-Timing": timer.getHeader(),
        },
      });

    this._isProd = actions.isProduction ?? isProd(env);

    /**
     * If we've been explicitly passed an Inngest dev sever URL, assume that
     * we shouldn't skip the dev server.
     */
    this._skipDevServer = devServerHost(env)
      ? false
      : this._isProd ?? skipDevServer(env);

    try {
      const runRes = await actions.run();

      if (runRes) {
        this.upsertKeysFromEnv(env);
        this.validateSignature(runRes.signature, runRes.data);
        this.client["inngestApi"].setSigningKey(this.signingKey);

        const stepRes = await this.runStep(
          runRes.fnId,
          runRes.stepId,
          runRes.data,
          timer
        );

        if (stepRes.status === 500 || stepRes.status === 400) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };

          if (stepRes.status === 400) {
            headers[headerKeys.NoRetry] = "true";
          }

          return {
            status: stepRes.status,
            body: stringify(
              stepRes.error ||
                serializeError(
                  new Error(
                    "Unknown error; function failed but no error was returned"
                  )
                )
            ),
            headers,
          };
        }

        return {
          status: stepRes.status,
          body: stringify(stepRes.body),
          headers: {
            "Content-Type": "application/json",
          },
        };
      }

      const viewRes = await actions.view();
      if (viewRes) {
        this.upsertKeysFromEnv(env);
        const registerBody = this.registerBody(this.reqUrl(actions.url));

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

      const registerRes = await actions.register();
      if (registerRes) {
        this.upsertKeysFromEnv(env);

        const { status, message, modified } = await this.register(
          this.reqUrl(actions.url),
          stringifyUnknown(env[envKeys.DevServerUrl]),
          registerRes.deployId,
          getHeaders
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
  ): Promise<StepRunResponse> {
    try {
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

      /**
       * TODO When the executor does support per-step errors, this map will need
       * to adjust to ensure we're not double-stacking the op inside `data`.
       */
      const opStack =
        ctx?.stack?.stack
          .slice(0, ctx.stack.current)
          .map<IncomingOp>((opId) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const step = steps?.[opId];
            if (typeof step === "undefined") {
              // TODO PrettyError
              throw new Error(`Could not find step with ID "${opId}"`);
            }

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            return { id: opId, data: step };
          }) ?? [];

      const ret = await fn.fn["runFn"](
        { event, events, runId: ctx?.run_id, attempt: ctx?.attempt },
        opStack,
        /**
         * TODO The executor is sending `"step"` as the step ID when it is not
         * wanting to run a specific step. This is not needed and we should
         * remove this on the executor side.
         */
        stepId === "step" ? null : stepId || null,
        timer,
        fn.onFailure
      );

      if (ret[0] === "complete") {
        return {
          status: 200,
          body: ret[1],
        };
      }

      /**
       * If the function has run user code and is intending to return an error,
       * interrupt this flow and instead throw a 500 to Inngest.
       *
       * The executor doesn't yet support per-step errors, so returning an
       * `error` key here would cause the executor to misunderstand what is
       * happening.
       *
       * TODO When the executor does support per-step errors, we can remove this
       * comment and check and functionality should resume as normal.
       */
      if (ret[0] === "run" && ret[1].error) {
        /**
         * We throw the `data` here instead of the `error` because we expect
         * `data` to be a prepared version of the error which may have been
         * altered by middleware, whereas `error` is the initial triggering
         * error.
         */
        throw new OutgoingResultError({
          data: ret[1].data,
          error: ret[1].error,
        });
      }

      return {
        status: 206,
        body: Array.isArray(ret[1]) ? ret[1] : [ret[1]],
      };
    } catch (unserializedErr) {
      /**
       * Always serialize the error before sending it back to Inngest. Errors,
       * by default, do not niceley serialize to JSON, so we use the a package
       * to do this.
       *
       * See {@link https://www.npmjs.com/package/serialize-error}
       */
      const isOutgoingOpError = unserializedErr instanceof OutgoingResultError;

      const error = stringify(
        serializeError(
          isOutgoingOpError ? unserializedErr.result.data : unserializedErr
        )
      );

      const isNonRetriableError = isOutgoingOpError
        ? unserializedErr.result.error instanceof NonRetriableError
        : unserializedErr instanceof NonRetriableError;

      /**
       * If we've caught a non-retriable error, we'll return a 400 to Inngest
       * to indicate that the error is not transient and should not be retried.
       *
       * The errors caught here are caught from the main function as well as
       * inside individual steps, so this safely catches all areas.
       */
      return {
        status: isNonRetriableError ? 400 : 500,
        error,
      };
    }
  }

  protected configs(url: URL): FunctionConfig[] {
    return Object.values(this.rawFns).reduce<FunctionConfig[]>(
      (acc, fn) => [...acc, ...fn["getConfig"](url, this.name)],
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

    if (this.servePath) ret.pathname = this.servePath;
    if (this.serveHost)
      ret = new URL(ret.pathname + ret.search, this.serveHost);

    /**
     * Remove any introspection query strings.
     */
    ret.searchParams.delete(queryKeys.Introspect);

    return ret;
  }

  protected registerBody(url: URL): RegisterRequest {
    const body: RegisterRequest = {
      url: url.href,
      deployType: "ping",
      framework: this.frameworkName,
      appName: this.name,
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
    devServerHost: string | undefined,
    deployId: string | undefined | null,
    getHeaders: () => Record<string, string>
  ): Promise<{ status: number; message: string; modified: boolean }> {
    const body = this.registerBody(url);

    let res: globalThis.Response;

    // Whenever we register, we check to see if the dev server is up.  This
    // is a noop and returns false in production.
    let registerURL = this.inngestRegisterUrl;

    if (!this._skipDevServer) {
      const hasDevServer = await devServerAvailable(devServerHost, this.fetch);
      if (hasDevServer) {
        registerURL = devServerUrl(devServerHost, "/fn/register");
      }
    }

    if (deployId) {
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
  private upsertKeysFromEnv(env: Record<string, unknown>) {
    if (!this.signingKey && env[envKeys.SigningKey]) {
      this.signingKey = String(env[envKeys.SigningKey]);
    }

    if (!this.client["eventKey"] && env[envKeys.EventKey]) {
      this.client.setEventKey(String(env[envKeys.EventKey]));
    }
  }

  protected validateSignature(
    sig: string | undefined,
    body: Record<string, unknown>
  ) {
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
        `No signing key found in client options or ${envKeys.SigningKey} env var. Find your keys at https://app.inngest.com/secrets`
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

      if (Object.hasOwnProperty.call(console, level)) {
        logger = console[level as keyof typeof console] as typeof logger;
      }

      logger(`inngest ${level as string}: `, ...args);
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => {
  env?: Record<string, unknown>;
  isProduction?: boolean;
  url: URL;
} & {
  [K in Extract<
    HandlerAction,
    { action: "run" | "register" | "view" }
  >["action"]]: () => MaybePromise<
    Omit<Extract<HandlerAction, { action: K }>, "action"> | undefined
  >;
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
 * A set of actions the SDK is aware of, including any payloads they require
 * when requesting them.
 */
type HandlerAction =
  | {
      action: "error";
      data: Record<string, string>;
    }
  | {
      action: "view";
      isIntrospection: boolean;
    }
  | {
      action: "register";
      deployId?: null | string;
    }
  | {
      action: "run";
      fnId: string;
      stepId: string | null;
      data: Record<string, unknown>;
      signature: string | undefined;
    }
  | {
      action: "bad-method";
    };
