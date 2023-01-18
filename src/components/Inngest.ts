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
  EventPayload,
  FunctionOptions,
  MultiStepFn,
  SingleStepFn,
} from "../types";
import { version } from "../version";
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
export class Inngest<Events extends Record<string, EventPayload>> {
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
  }: ClientOptions) {
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
      throw new Error(eventKeyError);
    }

    let payloads: ValueOf<Events>[];

    if (typeof nameOrPayload === "string") {
      /**
       * Add our payloads and ensure they all have a name.
       */
      payloads = (
        Array.isArray(maybePayload)
          ? maybePayload
          : maybePayload
          ? [maybePayload]
          : []
      ).map((payload) => ({
        ...payload,
        name: nameOrPayload,
      })) as typeof payloads;
    } else {
      /**
       * Grab our payloads straight from the args.
       */
      payloads = (
        Array.isArray(nameOrPayload)
          ? nameOrPayload
          : nameOrPayload
          ? [nameOrPayload]
          : []
      ) as typeof payloads;
    }

    /**
     * The two overload types should never allow this to happen, but in the case
     * the user is in JS Land and it does, let's throw.
     */
    if (!payloads.length) {
      throw new Error(
        "Provided a name but no events to send; make sure to send an event payload too"
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

  /**
   * Given an event to listen to, run the given step function when that event is
   * seen.
   *
   * These can be used to build multi-step, serverless workflows with delays,
   * conditional logic, and coordination between events.
   */
  public createStepFunction<
    Event extends keyof Events,
    Name extends string,
    Fn extends MultiStepFn<Events, Event, Name, "step">
  >(
    /**
     * The name of this function as it will appear in the Inngst Cloud UI.
     */
    name: Name,

    /**
     * The event to listen for.
     */
    event: Event,

    /**
     * The step function flow to run when the event is received.
     */
    fn: Fn
  ): InngestFunction<Events>;
  /**
   * Given an event to listen to, run the given step function when that event is
   * seen.
   *
   * These can be used to build multi-step, serverless workflows with delays,
   * conditional logic, and coordination between events.
   */
  public createStepFunction<
    Event extends keyof Events,
    Opts extends FunctionOptions,
    Fn extends MultiStepFn<
      Events,
      Event,
      Opts extends FunctionOptions ? Opts["name"] : string,
      "step"
    >
  >(
    /**
     * Options for this Inngest function - useful for defining a custom ID.
     */
    opts: Opts,

    /**
     * The event to listen for.
     */
    event: Event,

    /**
     * The function to run when the event is received.
     */
    fn: Fn
  ): InngestFunction<Events>;
  /**
   * Given an event to listen to, run the given step function when that event is
   * seen.
   *
   * These can be used to build multi-step, serverless workflows with delays,
   * conditional logic, and coordination between events.
   */
  public createStepFunction<
    Event extends keyof Events,
    Opts extends FunctionOptions | string,
    Fn extends MultiStepFn<
      Events,
      Event,
      Opts extends FunctionOptions
        ? Opts["name"]
        : Opts extends string
        ? Opts
        : string,
      "step"
    >
  >(nameOrOpts: Opts, event: Event, fn: Fn): InngestFunction<Events> {
    return new InngestFunction<Events>(
      typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
      { event: event as string },
      fn
    );
  }

  /**
   * Given an event to listen to, run the given function when that event is
   * seen.
   */
  public createFunction<
    Event extends keyof Events,
    Name extends string,
    Fn extends SingleStepFn<Events[Event], Name, "step">
  >(
    /**
     * The name of this function as it will appear in the Inngst Cloud UI.
     */
    name: Name,

    /**
     * The event to listen for.
     */
    event: Event,

    /**
     * The function to run when the event is received.
     */
    fn: Fn
  ): InngestFunction<Events>;
  /**
   * Given an event to listen to, run the given function when that event is
   * seen.
   */
  public createFunction<
    Event extends keyof Events,
    Opts extends FunctionOptions,
    Fn extends SingleStepFn<
      Events[Event],
      Opts extends FunctionOptions ? Opts["name"] : string,
      "step"
    >
  >(
    /**
     * Options for this Inngest function - useful for defining a custom ID.
     */
    opts: Opts,

    /**
     * The event to listen for.
     */
    event: Event,

    /**
     * The function to run when the event is received.
     */
    fn: Fn
  ): InngestFunction<Events>;
  /**
   * Given an event to listen to, run the given function when that event is
   * seen.
   */
  public createFunction<
    Event extends keyof Events,
    Opts extends FunctionOptions | string,
    Fn extends SingleStepFn<
      Events[Event],
      Opts extends FunctionOptions
        ? Opts["name"]
        : Opts extends string
        ? Opts
        : string,
      "step"
    >
  >(nameOrOpts: Opts, event: Event, fn: Fn): InngestFunction<Events> {
    return new InngestFunction<Events>(
      typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
      { event: event as string },
      fn
    );
  }

  /**
   * Run the given `fn` at a specified time or on a schedule given by `cron`.
   */
  public createScheduledFunction<Name extends string>(
    /**
     * The name of this function as it will appear in the Inngest Cloud UI.
     */
    name: Name,

    /**
     * The cron definition to schedule your function.
     *
     * @example
     *
     * "* * * * *" // Every minute
     * "0 * * * *" // Every hour
     * "0 0 * * *" // At the start of every day
     * "0 0 0 * *" // At the start of the first day of the month
     */
    cron: string,

    /**
     * The function to run.
     */
    fn: SingleStepFn<null, Name, "step">
  ): InngestFunction<Events>;
  /**
   * Run the given `fn` at a specified time or on a schedule given by `cron`.
   */
  public createScheduledFunction<Opts extends FunctionOptions>(
    /**
     * Options for this Inngest function - useful for defining a custom ID.
     */
    opts: Opts,

    /**
     * The cron definition to schedule your function.
     *
     * @example
     *
     * "* * * * *" // Every minute
     * "0 * * * *" // Every hour
     * "0 0 * * *" // At the start of every day
     * "0 0 0 * *" // At the start of the first day of the month
     */
    cron: string,

    /**
     * The function to run.
     */
    fn: SingleStepFn<
      null,
      Opts extends FunctionOptions ? Opts["name"] : string,
      "step"
    >
  ): InngestFunction<Events>;
  /**
   * Run the given `fn` at a specified time or on a schedule given by `cron`.
   */
  public createScheduledFunction<Opts extends FunctionOptions | string>(
    nameOrOpts: Opts,
    cron: string,
    fn: SingleStepFn<
      null,
      Opts extends FunctionOptions
        ? Opts["name"]
        : Opts extends string
        ? Opts
        : string,
      "step"
    >
  ): InngestFunction<Events> {
    return new InngestFunction<Events>(
      typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
      { cron },
      fn
    );
  }
}
