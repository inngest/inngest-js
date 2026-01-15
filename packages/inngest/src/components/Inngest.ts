import { InngestApi } from "../api/api.ts";
import {
  defaultDevServerHost,
  defaultInngestApiBaseUrl,
  defaultInngestEventBaseUrl,
  dummyEventKey,
  envKeys,
  headerKeys,
  logPrefix,
} from "../helpers/consts.ts";
import { createEntropy } from "../helpers/crypto.ts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver.ts";
import {
  allProcessEnv,
  getFetch,
  getMode,
  inngestHeaders,
  type Mode,
  processEnv,
} from "../helpers/env.ts";
import {
  type ErrCode,
  fixEventKeyMissingSteps,
  prettyError,
} from "../helpers/errors.ts";
import type { Jsonify } from "../helpers/jsonify.ts";
import { retryWithBackoff } from "../helpers/promises.ts";
import { stringify } from "../helpers/strings.ts";
import type {
  AsArray,
  IsNever,
  SendEventPayload,
  SimplifyDeep,
  SingleOrArray,
  WithoutInternal,
} from "../helpers/types.ts";
import {
  DefaultLogger,
  type Logger,
  ProxyLogger,
} from "../middleware/logger.ts";
import {
  type ClientOptions,
  type EventNameFromTrigger,
  type EventPayload,
  type FailureEventArgs,
  type Handler,
  type InvokeTargetFunctionDefinition,
  type MetadataTarget,
  type SendEventOutput,
  type SendEventResponse,
  sendEventResponseSchema,
  type TriggersFromClient,
} from "../types.ts";
import type { EventSchemas } from "./EventSchemas.ts";
import { InngestFunction } from "./InngestFunction.ts";
import type { InngestFunctionReference } from "./InngestFunctionReference.ts";
import {
  type MetadataBuilder,
  UnscopedMetadataBuilder,
} from "./InngestMetadata.ts";
import {
  type ExtendWithMiddleware,
  getHookStack,
  InngestMiddleware,
  type MiddlewareRegisterFn,
  type MiddlewareRegisterReturn,
  type SendEventHookStack,
} from "./InngestMiddleware.ts";
import type { Realtime } from "./realtime/types";

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
 * const inngest = new Inngest({ id: "my-app" });
 *
 * // or to provide event typing too
 * const inngest = new Inngest({
 *   id: "my-app",
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
export class Inngest<TClientOpts extends ClientOptions = ClientOptions>
  implements Inngest.Like
{
  get [Symbol.toStringTag](): typeof Inngest.Tag {
    return Inngest.Tag;
  }

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
   * Stores the options so we can remember explicit settings the user has
   * provided.
   */
  private readonly options: TClientOpts;

  /**
   * Inngest event key, used to send events to Inngest Cloud.
   */
  private eventKey = "";

  private _apiBaseUrl: string | undefined;
  private _eventBaseUrl: string | undefined;

  private readonly inngestApi: InngestApi;

  /**
   * The absolute URL of the Inngest Cloud API.
   */
  private sendEventUrl: URL = new URL(
    `e/${this.eventKey}`,
    defaultInngestEventBaseUrl,
  );

  private headers!: Record<string, string>;

  private readonly fetch: FetchT;

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in the SDK
  private readonly logger: Logger;

  private localFns: InngestFunction.Any[] = [];

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
  private _mode!: Mode;

  protected readonly schemas?: NonNullable<TClientOpts["schemas"]>;

  private _appVersion: string | undefined;

  /**
   * @internal
   * Flag set by metadataMiddleware to enable step.metadata()
   */
  protected experimentalMetadataEnabled = false;

  get apiBaseUrl(): string | undefined {
    return this._apiBaseUrl;
  }

  get eventBaseUrl(): string | undefined {
    return this._eventBaseUrl;
  }

  get env(): string | null {
    return this.headers[headerKeys.Environment] ?? null;
  }

  get appVersion(): string | undefined {
    return this._appVersion;
  }

  /**
   * Access the metadata builder for updating run and step metadata.
   *
   * @example
   * ```ts
   * // Update metadata for the current run
   * await inngest.metadata.update({ status: "processing" });
   *
   * // Update metadata for a different run
   * await inngest.metadata.run(otherRunId).update({ key: "val" });
   *
   * ```
   */
  get metadata(): MetadataBuilder {
    if (!this.experimentalMetadataEnabled) {
      throw new Error(
        'inngest.metadata is experimental. Enable it by adding metadataMiddleware() from "inngest/experimental" to your client middleware.',
      );
    }
    return new UnscopedMetadataBuilder(this);
  }

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
  constructor(options: TClientOpts) {
    this.options = options;

    const {
      id,
      fetch,
      logger = new DefaultLogger(),
      middleware,
      isDev,
      schemas,
      appVersion,
    } = this.options;

    if (!id) {
      // TODO PrettyError
      throw new Error("An `id` must be passed to create an Inngest instance.");
    }

    this.id = id;

    this._mode = getMode({
      explicitMode:
        typeof isDev === "boolean" ? (isDev ? "dev" : "cloud") : undefined,
    });

    this.fetch = getFetch(fetch);

    this.inngestApi = new InngestApi({
      baseUrl: this.apiBaseUrl,
      signingKey: processEnv(envKeys.InngestSigningKey) || "",
      signingKeyFallback: processEnv(envKeys.InngestSigningKeyFallback),
      fetch: this.fetch,
      mode: this.mode,
    });

    this.schemas = schemas;
    this.loadModeEnvVars();

    this.logger = logger;

    this.middleware = this.initializeMiddleware([
      ...builtInMiddleware,
      ...(middleware || []),
    ]);

    this._appVersion = appVersion;
  }

  /**
   * Returns a `Promise` that resolves when the app is ready and all middleware
   * has been initialized.
   */
  public get ready(): Promise<void> {
    return this.middleware.then(() => {});
  }

  /**
   * Set the environment variables for this client. This is useful if you are
   * passed environment variables at runtime instead of as globals and need to
   * update the client with those values as requests come in.
   */
  public setEnvVars(
    env: Record<string, string | undefined> = allProcessEnv(),
  ): this {
    this.mode = getMode({ env, client: this });

    return this;
  }

  private loadModeEnvVars(): void {
    this._apiBaseUrl =
      this.options.baseUrl ||
      this.mode["env"][envKeys.InngestApiBaseUrl] ||
      this.mode["env"][envKeys.InngestBaseUrl] ||
      this.mode.getExplicitUrl(defaultInngestApiBaseUrl);

    this._eventBaseUrl =
      this.options.baseUrl ||
      this.mode["env"][envKeys.InngestEventApiBaseUrl] ||
      this.mode["env"][envKeys.InngestBaseUrl] ||
      this.mode.getExplicitUrl(defaultInngestEventBaseUrl);

    this.setEventKey(
      this.options.eventKey || this.mode["env"][envKeys.InngestEventKey] || "",
    );

    this.headers = inngestHeaders({
      inngestEnv: this.options.env,
      env: this.mode["env"],
    });

    this.inngestApi["mode"] = this.mode;
    this.inngestApi["apiBaseUrl"] = this._apiBaseUrl;
  }

  /**
   * Initialize all passed middleware, running the `register` function on each
   * in sequence and returning the requested hook registrations.
   */
  private async initializeMiddleware(
    middleware: InngestMiddleware.Like[] = [],
    opts?: {
      registerInput?: Omit<Parameters<MiddlewareRegisterFn>[0], "client">;
      prefixStack?: Promise<MiddlewareRegisterReturn[]>;
    },
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
        const next = await (m as InngestMiddleware.Any).init({
          client: this,
          ...opts?.registerInput,
        });

        return [...prev, next];
      },
      Promise.resolve([]),
    );

    return [...prefix, ...(await stack)];
  }

  private get mode(): Mode {
    return this._mode;
  }

  private set mode(m) {
    this._mode = m;
    this.loadModeEnvVars();
  }

  /**
   * Given a response from Inngest, relay the error to the caller.
   */
  private async getResponseError(
    response: globalThis.Response,
    rawBody: unknown,
    foundErr = "Unknown error",
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
          errorMessage = `${JSON.stringify(await rawBody)}`;
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
          try {
            errorMessage = await response.text();
          } catch (_err) {
            errorMessage = `${JSON.stringify(await rawBody)}`;
          }
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
    eventKey: string,
  ): void {
    this.eventKey = eventKey || dummyEventKey;

    this.sendEventUrl = new URL(
      `e/${this.eventKey}`,
      this.eventBaseUrl || defaultInngestEventBaseUrl,
    );
  }

  private eventKeySet(): boolean {
    return Boolean(this.eventKey) && this.eventKey !== dummyEventKey;
  }

  /**
   * EXPERIMENTAL: This API is not yet stable and may change in the future
   * without a major version bump.
   *
   * Send a Signal to Inngest.
   */
  public async sendSignal({
    signal,
    data,
    env,
  }: {
    /**
     * The signal to send.
     */
    signal: string;

    /**
     * The data to send with the signal.
     */
    data?: unknown;

    /**
     * The Inngest environment to send the signal to. Defaults to whichever
     * environment this client's key is associated with.
     *
     * It's like you never need to change this unless you're trying to sync
     * multiple systems together using branch names.
     */
    env?: string;
  }): Promise<InngestApi.SendSignalResponse> {
    const headers: Record<string, string> = {
      ...(env ? { [headerKeys.Environment]: env } : {}),
    };

    return this._sendSignal({ signal, data, headers });
  }

  private async _sendSignal({
    signal,
    data,
    headers,
  }: {
    signal: string;
    data?: unknown;
    headers?: Record<string, string>;
  }): Promise<InngestApi.SendSignalResponse> {
    const res = await this.inngestApi.sendSignal(
      { signal, data },
      { ...this.headers, ...headers },
    );
    if (res.ok) {
      return res.value;
    }

    throw new Error(
      `Failed to send signal: ${res.error?.error || "Unknown error"}`,
    );
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in the SDK
  private async updateMetadata({
    target,
    metadata,
    headers,
  }: {
    target: MetadataTarget;
    metadata: Array<{
      kind: string;
      op: string;
      values: Record<string, unknown>;
    }>;
    headers?: Record<string, string>;
  }): Promise<void> {
    const res = await this.inngestApi.updateMetadata(
      {
        target,
        metadata,
      },
      { headers },
    );
    if (res.ok) {
      return res.value;
    }

    throw new Error(
      `Failed to update metadata: ${res.error?.error || "Unknown error"}`,
    );
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in the SDK
  private async warnMetadata(
    target: MetadataTarget,
    kind: ErrCode,
    text: string,
  ) {
    this.logger.warn(text);

    if (!this.experimentalMetadataEnabled) return;

    await this.updateMetadata({
      target: target,
      metadata: [
        {
          kind: "inngest.warnings",
          op: "merge",
          values: {
            [`sdk.${kind}`]: text,
          },
        },
      ],
    });
  }

  /**
   * TODO
   */
  public realtime: {
    /**
     * TODO
     */
    publish: Realtime.PublishFn;

    /**
     * TODO
     */
    getSubscriptionToken: Realtime.GetSubscriptionTokenFn;
  } = {
    publish: async (opts) => {
      const { topic, channel, data } = await opts;

      const res = await this.inngestApi.publish(
        {
          channel: channel,
          topics: [topic],
        },
        data,
      );

      if (res.ok) {
        return data;
      }

      throw new Error(
        `Failed to publish event: ${res.error?.error || "Unknown error"}`,
      );
    },

    getSubscriptionToken: async ({ channel, topics }) => {
      const channelId = typeof channel === "string" ? channel : channel.name;
      if (!channelId) {
        throw new Error(
          "Channel ID is required to create a subscription token",
        );
      }

      const key = await this.inngestApi.getSubscriptionToken(channelId, topics);

      return {
        channel: channelId,
        topics,
        key,
        // biome-ignore lint/suspicious/noExplicitAny: sacrifice for clean generics
      } as any;
    },
  };

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
  public async send<Payload extends SendEventPayload<GetEvents<this>>>(
    payload: Payload,
    options?: {
      /**
       * The Inngest environment to send events to. Defaults to whichever
       * environment this client's event key is associated with.
       *
       * It's likely you never need to change this unless you're trying to sync
       * multiple systems together using branch names.
       */
      env?: string;
    },
  ): Promise<SendEventOutput<TClientOpts>> {
    const headers: Record<string, string> = {
      ...(options?.env ? { [headerKeys.Environment]: options.env } : {}),
    };

    return this._send({ payload, headers });
  }

  /**
   * Internal method for sending an event, used to allow Inngest internals to
   * further customize the request sent to an Inngest Server.
   */
  private async _send<Payload extends SendEventPayload<GetEvents<this>>>({
    payload,
    headers,
  }: {
    payload: Payload;
    headers?: Record<string, string>;
  }): Promise<SendEventOutput<TClientOpts>> {
    const nowMillis = new Date().getTime();

    let maxAttempts = 5;

    // Attempt to set the event ID seed header. If it fails then disable retries
    // (but we still want to send the event).
    try {
      const entropy = createEntropy(10);
      const entropyBase64 = Buffer.from(entropy).toString("base64");
      headers = {
        ...headers,
        [headerKeys.EventIdSeed]: `${nowMillis},${entropyBase64}`,
      };
    } catch (err) {
      let message = "Event-sending retries disabled";
      if (err instanceof Error) {
        message += `: ${err.message}`;
      }

      console.debug(message);

      // Disable retries.
      maxAttempts = 1;
    }

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
      },
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
        // Always generate an idempotency ID for an event for retries
        id: p.id,
        ts: p.ts || nowMillis,
        data: p.data || {},
      };
    });

    const applyHookToOutput = async (
      arg: Parameters<NonNullable<SendEventHookStack["transformOutput"]>>[0],
    ): Promise<SendEventOutput<TClientOpts>> => {
      const hookOutput = await hooks.transformOutput?.(arg);
      return {
        ...arg.result,
        ...hookOutput?.result,
        // 🤮
      } as unknown as SendEventOutput<TClientOpts>;
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
        }),
      );

      return await applyHookToOutput({ result: { ids: [] } });
    }

    // When sending events, check if the dev server is available.  If so, use the
    // dev server.
    let url = this.sendEventUrl.href;

    /**
     * If in prod mode and key is not present, fail now.
     */
    if (this.mode.isCloud && !this.eventKeySet()) {
      throw new Error(
        prettyError({
          whatHappened: "Failed to send event",
          consequences: "Your event or events were not sent to Inngest.",
          why: "We couldn't find an event key to use to send events to Inngest.",
          toFixNow: fixEventKeyMissingSteps,
        }),
      );
    }

    /**
     * If dev mode has been inferred, try to hit the dev server first to see if
     * it exists. If it does, use it, otherwise fall back to whatever server we
     * have configured.
     *
     * `INNGEST_BASE_URL` is used to set both dev server and prod URLs, so if a
     * user has set this it means they have already chosen a URL to hit.
     */
    if (this.mode.isDev && this.mode.isInferred && !this.eventBaseUrl) {
      const devAvailable = await devServerAvailable(
        defaultDevServerHost,
        this.fetch,
      );

      if (devAvailable) {
        url = devServerUrl(defaultDevServerHost, `e/${this.eventKey}`).href;
      }
    }

    const body = await retryWithBackoff(
      async () => {
        let rawBody: unknown;
        let body: SendEventResponse | undefined;

        // We don't need to do fallback auth here because this uses event keys and
        // not signing keys
        const response = await this.fetch(url, {
          method: "POST",
          body: stringify(payloads),
          headers: { ...this.headers, ...headers },
        });

        try {
          rawBody = await response.json();
          body = await sendEventResponseSchema.parseAsync(rawBody);
        } catch (_err) {
          throw await this.getResponseError(response, rawBody);
        }

        if (body.status !== 200 || body.error) {
          throw await this.getResponseError(response, rawBody, body.error);
        }

        return body;
      },
      {
        maxAttempts,
        baseDelay: 100,
      },
    );

    return await applyHookToOutput({ result: { ids: body.ids } });
  }

  public createFunction: Inngest.CreateFunction<this> = (
    rawOptions,
    rawTrigger,
    handler,
  ) => {
    const fn = this._createFunction(rawOptions, rawTrigger, handler);

    this.localFns.push(fn);

    return fn;
  };

  public get funcs() {
    return this.localFns;
  }

  private _createFunction: Inngest.CreateFunction<this> = (
    rawOptions,
    rawTrigger,
    handler,
  ) => {
    const options = this.sanitizeOptions(rawOptions);
    const triggers = this.sanitizeTriggers(rawTrigger);

    return new InngestFunction(
      this,
      {
        ...options,
        triggers,
      },
      handler,
    );
  };

  /**
   * Runtime-only validation.
   */
  private sanitizeOptions<T extends InngestFunction.Options>(options: T): T {
    if (Object.hasOwn(options, "fns")) {
      // v2 -> v3 migration warning
      console.warn(
        `${logPrefix} InngestFunction: \`fns\` option has been deprecated in v3; use \`middleware\` instead. See https://www.inngest.com/docs/sdk/migration`,
      );
    }

    if (typeof options === "string") {
      // v2 -> v3 runtime migraton warning
      console.warn(
        `${logPrefix} InngestFunction: Creating a function with a string as the first argument has been deprecated in v3; pass an object instead. See https://www.inngest.com/docs/sdk/migration`,
      );

      return { id: options as string } as T;
    }

    return options;
  }

  /**
   * Runtime-only validation.
   */
  private sanitizeTriggers<
    T extends SingleOrArray<InngestFunction.Trigger<string>>,
  >(triggers: T): AsArray<T> {
    if (typeof triggers === "string") {
      // v2 -> v3 migration warning
      console.warn(
        `${logPrefix} InngestFunction: Creating a function with a string as the second argument has been deprecated in v3; pass an object instead. See https://www.inngest.com/docs/sdk/migration`,
      );

      return [{ event: triggers as string }] as AsArray<T>;
    }

    if (!Array.isArray(triggers)) {
      return [triggers] as AsArray<T>;
    }

    return triggers as AsArray<T>;
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
 *
 * This return pattern mimics the output of a `satisfies` suffix; it's used as
 * we support versions of TypeScript prior to the introduction of `satisfies`.
 */
export const builtInMiddleware = (<T extends InngestMiddleware.Stack>(
  m: T,
): T => m)([
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
                metadata: Record<string, unknown>,
              ) => Logger;
              providedLogger = (providedLogger.child as ChildLoggerFn)(
                metadata,
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
  export const Tag = "Inngest.App" as const;

  /**
   * Represents any `Inngest` instance, regardless of generics and inference.
   *
   * Prefer use of `Inngest.Like` where possible to ensure compatibility with
   * multiple versions.
   */
  export type Any = Inngest;

  /**
   * References any `Inngest` instance across library versions, useful for use
   * in public APIs to ensure compatibility with multiple versions.
   *
   * Prefer use of `Inngest.Any` internally and `Inngest.Like` for public APIs.
   */
  export interface Like {
    readonly [Symbol.toStringTag]: typeof Inngest.Tag;
  }

  export type CreateFunction<TClient extends Inngest.Any> = <
    TMiddleware extends InngestMiddleware.Stack,
    TTrigger extends SingleOrArray<
      InngestFunction.Trigger<TriggersFromClient<TClient>>
    >,
    THandler extends Handler.Any = Handler<
      TClient,
      EventNameFromTrigger<GetEvents<TClient, true>, AsArray<TTrigger>[number]>,
      ExtendWithMiddleware<
        [
          typeof builtInMiddleware,
          NonNullable<ClientOptionsFromInngest<TClient>["middleware"]>,
          TMiddleware,
        ]
      >
    >,
    TFailureHandler extends Handler.Any = Handler<
      TClient,
      EventNameFromTrigger<GetEvents<TClient, true>, AsArray<TTrigger>[number]>,
      ExtendWithMiddleware<
        [
          typeof builtInMiddleware,
          NonNullable<ClientOptionsFromInngest<TClient>["middleware"]>,
          TMiddleware,
        ],
        FailureEventArgs<
          GetEvents<TClient, true>[EventNameFromTrigger<
            GetEvents<TClient, true>,
            AsArray<TTrigger>[number]
          >]
        >
      >
    >,
  >(
    options: Omit<
      InngestFunction.Options<
        TClient,
        TMiddleware,
        AsArray<TTrigger>,
        TFailureHandler
      >,
      "triggers"
    >,
    trigger: TTrigger,
    handler: THandler,
  ) => InngestFunction<
    Omit<
      InngestFunction.Options<
        TClient,
        TMiddleware,
        AsArray<TTrigger>,
        TFailureHandler
      >,
      "triggers"
    >,
    THandler,
    TFailureHandler,
    TClient,
    TMiddleware,
    AsArray<TTrigger>
  >;
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
  TInngest extends Inngest.Any,
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
  TClient extends Inngest.Any,
  TTrigger extends TriggersFromClient<TClient> = TriggersFromClient<TClient>,
> = Parameters<
  // Handler<
  //   ClientOptionsFromInngest<TInngest>,
  //   GetEvents<TInngest, true>,
  //   TTrigger,
  //   ExtendWithMiddleware<
  //     [
  //       typeof builtInMiddleware,
  //       NonNullable<ClientOptionsFromInngest<TInngest>["middleware"]>,
  //     ]
  //   >
  // >
  Handler<
    TClient,
    TTrigger,
    ExtendWithMiddleware<
      [
        typeof builtInMiddleware,
        NonNullable<ClientOptionsFromInngest<TClient>["middleware"]>,
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
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
> = TFunction extends InngestFunction<any, infer IHandler, any, any, any, any>
  ? IsNever<SimplifyDeep<Jsonify<Awaited<ReturnType<IHandler>>>>> extends true
    ? null
    : SimplifyDeep<Jsonify<Awaited<ReturnType<IHandler>>>>
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
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
> = TFunction extends InngestFunctionReference<any, infer IOutput>
  ? IsNever<SimplifyDeep<Jsonify<IOutput>>> extends true
    ? null
    : SimplifyDeep<Jsonify<IOutput>>
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

export type ClientOptionsFromInngest<TInngest extends Inngest.Any> =
  TInngest extends Inngest<infer U> ? U : ClientOptions;
