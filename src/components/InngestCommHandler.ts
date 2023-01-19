import { hmac, sha256 } from "hash.js";
import { z } from "zod";
import { envKeys, queryKeys } from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import { strBoolean } from "../helpers/scalar";
import type { MaybePromise } from "../helpers/types";
import { landing } from "../landing";
import type {
  FunctionConfig,
  IntrospectRequest,
  RegisterOptions,
  RegisterRequest,
  StepRunResponse,
} from "../types";
import { version } from "../version";
import type { Inngest } from "./Inngest";
import type { InngestFunction } from "./InngestFunction";
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
  nameOrInngest: string | Inngest<any>,

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: InngestFunction<any>[],

  /**
   * A set of options to further configure the registration of Inngest
   * functions.
   */
  opts?: RegisterOptions
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
export class InngestCommHandler<H extends Handler, TransformedRes> {
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
  public readonly transformRes: (
    res: ActionResponse,
    ...args: Parameters<H>
  ) => TransformedRes;

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
   * A set of headers sent back with every request. Usually includes generic
   * functionality such as `"Content-Type"`, alongside informational headers
   * such as Inngest SDK version.
   */
  private readonly headers: Record<string, string>;

  /**
   * The localized `fetch` implementation used by this handler.
   */
  private readonly fetch: FetchT;

  /**
   * Whether we should show the SDK Landing Page.
   *
   * This purposefully does not take in to account any environment variables, as
   * accessing them safely is platform-specific.
   */
  protected readonly showLandingPage: boolean | undefined;

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
   * A private collection of functions that are being served. This map is used
   * to find and register functions when interacting with Inngest Cloud.
   */
  private readonly fns: Record<string, InngestFunction<any>> = {};

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
    appNameOrInngest: string | Inngest<any>,

    /**
     * An array of the functions to serve and register with Inngest.
     */
    functions: InngestFunction<any>[],
    {
      inngestRegisterUrl,
      fetch,
      landingPage,
      signingKey,
      serveHost,
      servePath,
    }: RegisterOptions = {},

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
    transformRes: (
      actionRes: ActionResponse,
      ...args: Parameters<H>
    ) => TransformedRes
  ) {
    this.frameworkName = frameworkName;
    this.name =
      typeof appNameOrInngest === "string"
        ? appNameOrInngest
        : appNameOrInngest.name;

    this.handler = handler;
    this.transformRes = transformRes;

    /**
     * Provide a hidden option to allow expired signatures to be accepted during
     * testing.
     */
    this.allowExpiredSignatures = Boolean(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, prefer-rest-params
      arguments["3"]?.__testingAllowExpiredSignatures
    );

    this.fns = functions.reduce<Record<string, InngestFunction<any>>>(
      (acc, fn) => {
        const id = fn.id(this.name);

        if (acc[id]) {
          throw new Error(
            `Duplicate function ID "${id}"; please change a function's name or provide an explicit ID to avoid conflicts.`
          );
        }

        return {
          ...acc,
          [id]: fn,
        };
      },
      {}
    );

    this.inngestRegisterUrl = new URL(
      inngestRegisterUrl || "https://api.inngest.com/fn/register"
    );

    this.signingKey = signingKey;
    this.showLandingPage = landingPage;
    this.serveHost = serveHost;
    this.servePath = servePath;

    this.headers = {
      "Content-Type": "application/json",
      "User-Agent": `inngest-js:v${version} (${this.frameworkName})`,
    };

    this.fetch =
      fetch ||
      (typeof appNameOrInngest === "string"
        ? undefined
        : appNameOrInngest["fetch"]) ||
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require("cross-fetch") as FetchT);
  }

  // hashedSigningKey creates a sha256 checksum of the signing key with the
  // same signing key prefix.
  private get hashedSigningKey(): string {
    if (!this.signingKey) {
      return "";
    }

    const prefix =
      this.signingKey.match(/^signkey-(test|prod)-/)?.shift() || "";
    const key = this.signingKey.replace(/^signkey-(test|prod)-/, "");

    // Decode the key from its hex representation into a bytestream
    return `${prefix}${sha256().update(key, "hex").digest("hex")}`;
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
  public createHandler(): (...args: Parameters<H>) => Promise<TransformedRes> {
    return async (...args: Parameters<H>) => {
      /**
       * We purposefully `await` the handler, as it could be either sync or
       * async.
       */
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const actions = await this.handler(...args);

      const actionRes = await this.handleAction(
        actions as ReturnType<Awaited<H>>
      );

      return this.transformRes(actionRes, ...args);
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
  private async handleAction(actions: ReturnType<H>): Promise<ActionResponse> {
    const headers = { "x-inngest-sdk": this.sdkHeader.join("") };

    try {
      const runRes = await actions.run();

      if (runRes) {
        this._isProd = runRes.isProduction;
        this.upsertSigningKeyFromEnv(runRes.env);
        this.validateSignature(runRes.signature, runRes.data);

        const stepRes = await this.runStep(runRes.fnId, "step", runRes.data);

        if (stepRes.status === 500 || stepRes.status === 400) {
          return {
            status: stepRes.status,
            body: stepRes.error || "",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
          };
        }

        return {
          status: stepRes.status,
          body: JSON.stringify(stepRes.body),
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        };
      }

      const viewRes = await actions.view();
      if (viewRes) {
        this._isProd = viewRes.isProduction;
        this.upsertSigningKeyFromEnv(viewRes.env);

        const showLandingPage = this.shouldShowLandingPage(
          viewRes.env[envKeys.LandingPage]
        );

        if (this._isProd || !showLandingPage) {
          return {
            status: 405,
            body: "",
            headers,
          };
        }

        if (viewRes.isIntrospection) {
          const introspection: IntrospectRequest = {
            ...this.registerBody(this.reqUrl(viewRes.url)),
            devServerURL: devServerUrl(viewRes.env[envKeys.DevServerUrl]).href,
            hasSigningKey: Boolean(this.signingKey),
          };

          return {
            status: 200,
            body: JSON.stringify(introspection),
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
          };
        }

        return {
          status: 200,
          body: landing,
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
          },
        };
      }

      const registerRes = await actions.register();
      if (registerRes) {
        this._isProd = registerRes.isProduction;
        this.upsertSigningKeyFromEnv(registerRes.env);

        const { status, message } = await this.register(
          this.reqUrl(registerRes.url),
          registerRes.env[envKeys.DevServerUrl],
          registerRes.deployId
        );

        return {
          status,
          body: JSON.stringify({ message }),
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        };
      }
    } catch (err: any) {
      return {
        status: 500,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        body: JSON.stringify(err.stack || err.message || err),
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
      };
    }

    return {
      status: 405,
      body: "",
      headers,
    };
  }

  protected async runStep(
    functionId: string,
    stepId: string,
    data: any
  ): Promise<StepRunResponse> {
    try {
      const fn = this.fns[functionId];
      if (!fn) {
        throw new Error(`Could not find function with ID "${functionId}"`);
      }

      const { event, steps } = z
        .object({
          event: z.object({}).passthrough(),
          steps: z.object({}).passthrough().optional().nullable(),
        })
        .parse(data);

      const ret = await fn["runFn"]({ event }, steps || {});
      const isOp = ret[0];

      if (isOp) {
        return {
          status: 206,
          body: ret[1],
        };
      }

      return {
        status: 200,
        body: ret[1],
      };
    } catch (err: unknown) {
      /**
       * If we've caught a non-retriable error, we'll return a 400 to Inngest
       * to indicate that the error is not transient and should not be retried.
       *
       * The errors caught here are caught from the main function as well as
       * inside individual steps, so this safely catches all areas.
       */
      if (err instanceof NonRetriableError) {
        return {
          status: 400,
          error: JSON.stringify({
            message: err.message,
            stack: err.stack,
            name: err.name,
            cause: err.cause
              ? err.cause instanceof Error
                ? err.cause.stack || err.cause.message
                : JSON.stringify(err.cause)
              : undefined,
          }),
        };
      }

      if (err instanceof Error) {
        return {
          status: 500,
          error: err.stack || err.message,
        };
      }

      return {
        status: 500,
        error: `Unknown error: ${JSON.stringify(err)}`,
      };
    }
  }

  protected configs(url: URL): FunctionConfig[] {
    return Object.values(this.fns).map((fn) => fn["getConfig"](url, this.name));
  }

  /**
   * Returns an SDK header split in to three parts so that they can be used for
   * different purposes.
   *
   * To use the entire string, run `this.sdkHeader.join("")`.
   */
  protected get sdkHeader(): [
    prefix: string,
    version: RegisterRequest["sdk"],
    suffix: string
  ] {
    return ["inngest-", `js:v${version}`, ` (${this.frameworkName})`];
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
      sdk: this.sdkHeader[1],
      v: "0.1",
    };

    // Calculate the checksum of the body... without the checksum itself being included.
    body.hash = sha256().update(JSON.stringify(body)).digest("hex");
    return body;
  }

  protected async register(
    url: URL,
    devServerHost: string | undefined,
    deployId?: string | undefined | null
  ): Promise<{ status: number; message: string }> {
    const body = this.registerBody(url);

    let res: globalThis.Response;

    // Whenever we register, we check to see if the dev server is up.  This
    // is a noop and returns false in production.
    let registerURL = this.inngestRegisterUrl;

    if (!this.isProd) {
      const hasDevServer = await devServerAvailable(devServerHost, this.fetch);
      if (hasDevServer) {
        registerURL = devServerUrl(devServerHost, "/fn/register");
      }
    }

    if (deployId) {
      registerURL.searchParams.set("deployId", deployId);
    }

    try {
      res = await this.fetch(registerURL.href, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          ...this.headers,
          Authorization: `Bearer ${this.hashedSigningKey}`,
        },
        redirect: "follow",
      });
    } catch (err: unknown) {
      console.error(err);

      return {
        status: 500,
        message: `Failed to register${
          err instanceof Error ? `; ${err.message}` : ""
        }`,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    let data: z.input<typeof registerResSchema> = {};

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data = await res.json();
    } catch (err) {
      console.warn("Couldn't unpack register response:", err);
    }
    const { status, error, skipped } = registerResSchema.parse(data);

    // The dev server polls this endpoint to register functions every few
    // seconds, but we only want to log that we've registered functions if
    // the function definitions change.  Therefore, we compare the body sent
    // during registration with the body of the current functions and refuse
    // to register if the functions are the same.
    if (!skipped) {
      console.log(
        "registered inngest functions:",
        res.status,
        res.statusText,
        data
      );
    }

    return { status, message: error };
  }

  private get isProd() {
    return this._isProd;
  }

  private upsertSigningKeyFromEnv(env: Record<string, string | undefined>) {
    if (!this.signingKey && env[envKeys.SigningKey]) {
      this.signingKey = env[envKeys.SigningKey];
    }
  }

  protected shouldShowLandingPage(strEnvVar: string | undefined): boolean {
    return this.showLandingPage ?? strBoolean(strEnvVar) ?? true;
  }

  protected validateSignature(
    sig: string | undefined,
    body: Record<string, any>
  ) {
    if (this.isProd && !sig) {
      throw new Error("No x-inngest-signature provided");
    }

    if (!this.isProd && !this.signingKey) {
      return;
    }

    if (!this.signingKey) {
      console.warn(
        "No signing key provided to validate signature.  Find your dev keys at https://app.inngest.com/test/secrets"
      );
      return;
    }

    if (!sig) {
      console.warn("No x-inngest-signature provided");
      return;
    }

    new RequestSignature(sig).verifySignature({
      body,
      allowExpiredSignatures: this.allowExpiredSignatures,
      signingKey: this.signingKey,
    });
  }

  protected signResponse(): string {
    return "";
  }
}

class RequestSignature {
  public timestamp: number;
  public signature: string;

  constructor(sig: string) {
    const params = new URLSearchParams(sig);
    this.timestamp = Number(params.get("t"));
    this.signature = params.get("s") || "";

    if (!this.timestamp || !this.signature) {
      throw new Error("Invalid x-inngest-signature provided");
    }
  }

  private hasExpired(allowExpiredSignatures?: boolean) {
    if (allowExpiredSignatures) {
      return false;
    }

    const delta = Date.now() - new Date(this.timestamp * 1000).valueOf();
    return delta > 1000 * 60 * 5;
  }

  public verifySignature({
    body,
    signingKey,
    allowExpiredSignatures,
  }: {
    body: any;
    signingKey: string;
    allowExpiredSignatures: boolean;
  }): void {
    if (this.hasExpired(allowExpiredSignatures)) {
      throw new Error("Signature has expired");
    }

    // Calculate the HMAC of the request body ourselves.
    const encoded = typeof body === "string" ? body : JSON.stringify(body);
    // Remove the /signkey-[test|prod]-/ prefix from our signing key to calculate the HMAC.
    const key = signingKey.replace(/signkey-\w+-/, "");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const mac = hmac(sha256 as any, key)
      .update(encoded)
      .update(this.timestamp)
      .digest("hex");

    if (mac !== this.signature) {
      throw new Error("Invalid signature");
    }
  }
}

/**
 * The broad definition of a handler passed when instantiating an
 * {@link InngestCommHandler} instance.
 */
type Handler = (...args: any[]) => {
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
export interface ActionResponse {
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
  body: string;
}

/**
 * A set of actions the SDK is aware of, including any payloads they require
 * when requesting them.
 */
type HandlerAction =
  | {
      action: "error";
      data: Record<string, string>;
      env: Record<string, string | undefined>;
      isProduction: boolean;
      url: URL;
    }
  | {
      action: "view";
      env: Record<string, string | undefined>;
      url: URL;
      isIntrospection: boolean;
      isProduction: boolean;
    }
  | {
      action: "register";
      env: Record<string, string | undefined>;
      url: URL;
      isProduction: boolean;
      deployId?: null | string;
    }
  | {
      action: "run";
      fnId: string;
      data: Record<string, any>;
      env: Record<string, string | undefined>;
      isProduction: boolean;
      url: URL;
      signature: string | undefined;
    }
  | {
      action: "bad-method";
      env: Record<string, string | undefined>;
      isProduction: boolean;
      url: URL;
    };
