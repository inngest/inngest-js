import { envKeys } from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import { devServerHost, isProd, processEnv } from "../helpers/env";
import type {
  PartialK,
  SendEventPayload,
  SingleOrArray,
  ValueOf,
} from "../helpers/types";
import type {
  ClientOptions,
  EventNameFromTrigger,
  EventPayload,
  FailureEventArgs,
  FunctionOptions,
  FunctionTrigger,
  Handler,
  ShimmedFns,
  TriggerOptions,
} from "../types";
import { version } from "../version";
import { EventSchemas } from "./EventSchemas";
import { InngestFunction } from "./InngestFunction";

/**
 * Capturing the global type of fetch so that we can reliably access it below.
 */
type FetchT = typeof fetch;

export const eventKeyWarning =
  "Could not find an event key to send events; sending will throw unless an event key is added. Please pass one to the constructor, set the INNGEST_EVENT_KEY environment variable, or use inngest.setEventKey() at runtime.";

export const eventKeyError =
  "Could not find an event key to send events. Please pass one to the constructor, set the INNGEST_EVENT_KEY environment variable, or use inngest.setEventKey() at runtime.";

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
 * To provide event typing, make sure to pass in your generated event types as
 * the first generic.
 *
 * ```ts
 * const inngest = new Inngest<Events>({ name: "My App" });
 *
 * // or to provide custom events too
 * const inngest = new Inngest<
 *   Events & {
 *     "app/user.created": {
 *       name: "app/user.created";
 *       data: {
 *         foo: boolean;
 *       };
 *     };
 *   }
 * >({ name: "My App" });
 * ```
 *
 * @public
 */
export class Inngest<TOpts extends ClientOptions = ClientOptions> {
  /**
   * The name of this instance, most commonly the name of the application it
   * resides in.
   */
  public readonly name: string;

  /**
   * Inngest event key, used to send events to Inngest Cloud.
   */
  private eventKey = "";

  /**
   * Base URL for Inngest Cloud.
   */
  public readonly inngestBaseUrl: URL;

  /**
   * The absolute URL of the Inngest Cloud API.
   */
  private inngestApiUrl: URL = new URL(`e/${this.eventKey}`, "https://inn.gs/");

  private readonly headers: Record<string, string>;

  private readonly fetch: FetchT;

  /**
   * A client used to interact with the Inngest API by sending or reacting to
   * events.
   *
   * To provide event typing, make sure to pass in your generated event types as
   * the first generic.
   *
   * ```ts
   * const inngest = new Inngest<Events>({ name: "My App" });
   *
   * // or to provide custom events too
   * const inngest = new Inngest<
   *   Events & {
   *     "app/user.created": {
   *       name: "app/user.created";
   *       data: {
   *         foo: boolean;
   *       };
   *     };
   *   }
   * >({ name: "My App" });
   * ```
   */
  constructor({
    name,
    eventKey,
    inngestBaseUrl = "https://inn.gs/",
    fetch,
  }: TOpts) {
    if (!name) {
      throw new Error("A name must be passed to create an Inngest instance.");
    }

    this.name = name;
    this.inngestBaseUrl = new URL(inngestBaseUrl);
    this.setEventKey(eventKey || processEnv(envKeys.EventKey) || "");

    if (!this.eventKey) {
      console.warn(eventKeyWarning);
    }

    this.headers = {
      "Content-Type": "application/json",
      "User-Agent": `InngestJS v${version}`,
    };

    this.fetch = Inngest.parseFetch(fetch);
  }

  /**
   * Given a potential fetch function, return the fetch function to use based on
   * this and the environment.
   */
  private static parseFetch(fetchArg: FetchT | undefined): FetchT {
    if (fetchArg) {
      return fetchArg;
    }

    if (typeof fetch !== "undefined") {
      return fetch;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("cross-fetch") as FetchT;
  }

  /**
   * Given a response from Inngest, relay the error to the caller.
   */
  async #getResponseError(response: globalThis.Response): Promise<Error> {
    let errorMessage = "Unknown error";
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
    this.eventKey = eventKey;
    this.inngestApiUrl = new URL(`e/${this.eventKey}`, this.inngestBaseUrl);
  }

  /**
   * Send one or many events to Inngest. Takes a known event from this Inngest
   * instance based on the given `name`.
   *
   * ```ts
   * await inngest.send("app/user.created", { data: { id: 123 } });
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
   * const inngest = new Inngest<Events & {
   *   "my/event": {
   *     name: "my/event";
   *     data: { bar: string; };
   *   }
   * }>("My App", "API_KEY");
   * ```
   */
  public async send<Event extends keyof EventsFromOpts<TOpts>>(
    name: Event,
    payload: SingleOrArray<
      PartialK<Omit<EventsFromOpts<TOpts>[Event], "name" | "v">, "ts">
    >
  ): Promise<void>;
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
   * const inngest = new Inngest<Events & {
   *   "my/event": {
   *     name: "my/event";
   *     data: { bar: string; };
   *   }
   * }>("My App", "API_KEY");
   * ```
   */
  public async send<Payload extends SendEventPayload<EventsFromOpts<TOpts>>>(
    payload: Payload
  ): Promise<void>;
  public async send<Event extends keyof EventsFromOpts<TOpts>>(
    nameOrPayload:
      | Event
      | SingleOrArray<
          ValueOf<{
            [K in keyof EventsFromOpts<TOpts>]: PartialK<
              Omit<EventsFromOpts<TOpts>[K], "v">,
              "ts"
            >;
          }>
        >,
    maybePayload?: SingleOrArray<
      PartialK<Omit<EventsFromOpts<TOpts>[Event], "name" | "v">, "ts">
    >
  ): Promise<void> {
    if (!this.eventKey) {
      throw new Error(eventKeyError);
    }

    let payloads: ValueOf<EventsFromOpts<TOpts>>[];

    if (typeof nameOrPayload === "string") {
      /**
       * Add our payloads and ensure they all have a name.
       */
      payloads = (Array.isArray(maybePayload)
        ? maybePayload
        : maybePayload
        ? [maybePayload]
        : []
      ).map((payload) => ({
        ...payload,
        name: nameOrPayload,
      })) as unknown as typeof payloads;
    } else {
      /**
       * Grab our payloads straight from the args.
       */
      payloads = (Array.isArray(nameOrPayload)
        ? nameOrPayload
        : nameOrPayload
        ? [nameOrPayload]
        : []) as unknown as typeof payloads;
    }

    /**
     * It can be valid for a user to send an empty list of events; if this
     * happens, show a warning that this may not be intended, but don't throw.
     */
    if (!payloads.length) {
      return console.warn(
        "Warning: You have called `inngest.send()` with an empty array; the operation will resolve, but no events have been sent. This may be intentional, in which case you can ignore this warning."
      );
    }

    // When sending events, check if the dev server is available.  If so, use the
    // dev server.
    let url = this.inngestApiUrl.href;

    if (!isProd()) {
      const host = devServerHost();
      // If the dev server host env var has been set we always want to use
      // the dev server - even if it's down.  Otherwise, optimistically use
      // it for non-prod services.
      if (host !== undefined || (await devServerAvailable(host, this.fetch))) {
        url = devServerUrl(host, `e/${this.eventKey}`).href;
      }
    }

    const response = await this.fetch(url, {
      method: "POST",
      body: JSON.stringify(payloads),
      headers: { ...this.headers },
    });

    if (response.status >= 200 && response.status < 300) {
      return;
    }

    throw await this.#getResponseError(response);
  }

  public createFunction<
    TFns extends Record<string, unknown>,
    TTrigger extends TriggerOptions<keyof EventsFromOpts<TOpts> & string>,
    TShimmedFns extends Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (...args: any[]) => any
    > = ShimmedFns<TFns>,
    TTriggerName extends keyof EventsFromOpts<TOpts> &
      string = EventNameFromTrigger<EventsFromOpts<TOpts>, TTrigger>
  >(
    nameOrOpts:
      | string
      | (Omit<
          FunctionOptions<EventsFromOpts<TOpts>, TTriggerName>,
          "fns" | "onFailure"
        > & {
          /**
           * Pass in an object of functions that will be wrapped in Inngest
           * tooling and passes to your handler. This wrapping ensures that each
           * function is automatically separated and retried.
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
           *   async ({ fns: { createUser } }) => {
           *     await createUser("Alice");
           *   }
           * );
           *
           * // Or always use `run()` to run inline steps and use them directly
           * inngest.createFunction(
           *   { name: "Create user from PR" },
           *   { event: "github/pull_request" },
           *   async ({ step: { run } }) => {
           *     await run("createUser", () => userDb.createUser("Alice"));
           *   }
           * );
           * ```
           */
          fns?: TFns;

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
            TShimmedFns,
            FailureEventArgs<EventsFromOpts<TOpts>[TTriggerName]>
          >;
        }),
    trigger: TTrigger,
    handler: Handler<TOpts, EventsFromOpts<TOpts>, TTriggerName, TShimmedFns>
  ): InngestFunction<
    TOpts,
    EventsFromOpts<TOpts>,
    FunctionTrigger<keyof EventsFromOpts<TOpts> & string>,
    FunctionOptions<EventsFromOpts<TOpts>, keyof EventsFromOpts<TOpts> & string>
  > {
    const sanitizedOpts = (
      typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts
    ) as FunctionOptions<
      EventsFromOpts<TOpts>,
      keyof EventsFromOpts<TOpts> & string
    >;

    return new InngestFunction(
      this,
      sanitizedOpts,
      typeof trigger === "string" ? { event: trigger } : trigger,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      handler as any
    );
  }
}
