import { envKeys } from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import {
  devServerHost,
  getFetch,
  inngestHeaders,
  isProd,
  processEnv,
} from "../helpers/env";
import { prettyError } from "../helpers/errors";
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
  Handler,
  ShimmedFns,
  TriggerOptions,
} from "../types";
import { InngestFunction } from "./InngestFunction";

/**
 * Capturing the global type of fetch so that we can reliably access it below.
 */
type FetchT = typeof fetch;

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
export class Inngest<
  Events extends Record<string, EventPayload> = Record<string, EventPayload>
> {
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
    env,
  }: ClientOptions) {
    if (!name) {
      throw new Error("A name must be passed to create an Inngest instance.");
    }

    this.name = name;
    this.inngestBaseUrl = new URL(inngestBaseUrl);
    this.setEventKey(eventKey || processEnv(envKeys.EventKey) || "");

    if (!this.eventKey) {
      console.warn(
        prettyError({
          type: "warn",
          whatHappened: "Could not find event key",
          consequences:
            "Sending events will throw in production unless an event key is added.",
          toFixNow: [
            "Pass a key to the `new Inngest()` constructor using the `eventKey` option",
            "Set the `INNGEST_EVENT_KEY` environment variable",
            "Use `inngest.setEventKey()` at runtime",
          ],
          why: "We couldn't find an event key to use to send events to Inngest.",
          otherwise:
            "Create a new production event key at https://app.inngest.com/env/production/manage/keys.",
        })
      );
    }

    this.headers = inngestHeaders({
      inngestEnv: env,
    });

    this.fetch = getFetch(fetch);
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
  public async send<Event extends keyof Events>(
    name: Event,
    payload: SingleOrArray<PartialK<Omit<Events[Event], "name" | "v">, "ts">>
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
  public async send<Payload extends SendEventPayload<Events>>(
    payload: Payload
  ): Promise<void>;
  public async send<Event extends keyof Events>(
    nameOrPayload:
      | Event
      | SingleOrArray<
          ValueOf<{
            [K in keyof Events]: PartialK<Omit<Events[K], "v">, "ts">;
          }>
        >,
    maybePayload?: SingleOrArray<
      PartialK<Omit<Events[Event], "name" | "v">, "ts">
    >
  ): Promise<void> {
    if (!this.eventKey) {
      throw new Error(
        prettyError({
          whatHappened: "Failed to send event",
          consequences: "Your event or events were not sent to Inngest.",
          why: "We couldn't find an event key to use to send events to Inngest.",
          toFixNow: [
            `Pass a key to the \`new Inngest()\` constructor using the \`${
              "eventKey" satisfies keyof ClientOptions
            }\` option`,
            "Set the `INNGEST_EVENT_KEY` environment variable",
            `Use \`inngest.${
              "setEventKey" satisfies keyof Inngest
            }()\` at runtime`,
          ],
        })
      );
    }

    let payloads: ValueOf<Events>[];

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
    TTrigger extends TriggerOptions<keyof Events & string>,
    TShimmedFns extends Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (...args: any[]) => any
    > = ShimmedFns<TFns>,
    TTriggerName extends keyof Events & string = EventNameFromTrigger<
      Events,
      TTrigger
    >
  >(
    nameOrOpts:
      | string
      | (Omit<FunctionOptions<Events, TTriggerName>, "fns" | "onFailure"> & {
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
            Events,
            TTriggerName,
            TShimmedFns,
            FailureEventArgs<Events[TTriggerName]>
          >;
        }),
    trigger: TTrigger,
    handler: Handler<Events, TTriggerName, TShimmedFns>
  ): InngestFunction {
    const opts = (
      typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts
    ) as FunctionOptions<Events, keyof Events & string>;

    return new InngestFunction(
      this,
      opts,
      typeof trigger === "string" ? { event: trigger } : trigger,
      handler as Handler<Events, keyof Events & string>
    ) as unknown as InngestFunction;
  }
}
