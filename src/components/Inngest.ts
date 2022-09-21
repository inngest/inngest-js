import axios, { AxiosInstance, AxiosResponse } from "axios";
import { SingleOrArray, ValueOf } from "../helpers/types";
import { ClientOptions, EventPayload, FunctionOptions, StepFn } from "../types";
import { version } from "../version";
import { InngestFunction } from "./InngestFunction";
import { InngestStep } from "./InngestStep";

/**
 * A client used to interact with the Inngest API by sending or reacting to
 * events.
 *
 * To provide event typing, make sure to pass in your generated event types as
 * the first generic.
 *
 * ```ts
 * const inngest = new Inngest<Events>("My App", process.env.INNGEST_EVENT_KEY);
 *
 * // or to provide custom events too
 * const inngest = new Inngest<
 *   Events & {
 *     "demo/event.blah": {
 *       name: "demo/event.blah";
 *       data: {
 *         bar: boolean;
 *       };
 *     };
 *   }
 * >("My App", process.env.INNGEST_EVENT_KEY);
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
  private readonly eventKey: string;

  /**
   * Base URL for Inngest Cloud.
   */
  public readonly inngestBaseUrl: URL;

  /**
   * The absolute URL of the Inngest Cloud API.
   */
  private readonly inngestApiUrl: URL;

  /**
   * An Axios instance used for communicating with Inngest Cloud.
   *
   * {@link https://npm.im/axios}
   */
  private readonly client: AxiosInstance;

  /**
   * A client used to interact with the Inngest API by sending or reacting to
   * events.
   *
   * To provide event typing, make sure to pass in your generated event types as
   * the first generic.
   *
   * ```ts
   * const inngest = new Inngest<Events>("My App", process.env.INNGEST_EVENT_KEY);
   *
   * // or to provide custom events too
   * const inngest = new Inngest<
   *   Events & {
   *     "demo/event.blah": {
   *       name: "demo/event.blah";
   *       data: {
   *         bar: boolean;
   *       };
   *     };
   *   }
   * >("My App", process.env.INNGEST_EVENT_KEY);
   * ```
   */
  constructor({
    name,
    eventKey = process.env.INNGEST_EVENT_KEY,
    inngestBaseUrl = "https://inn.gs/",
  }: ClientOptions) {
    if (!name) {
      throw new Error("A name must be passed to create an Inngest instance.");
    }

    if (!eventKey) {
      throw new Error(
        "An event key must be passed to create an Inngest instance."
      );
    }

    this.name = name;
    this.eventKey = eventKey;
    this.inngestBaseUrl = new URL(inngestBaseUrl);
    this.inngestApiUrl = new URL(`e/${this.eventKey}`, this.inngestBaseUrl);

    this.client = axios.create({
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `InngestJS v${version}`,
      },
      validateStatus: () => true, // all status codes return a response
      maxRedirects: 0,
    });
  }

  /**
   * Given a response from Inngest, relay the error to the caller.
   */
  #getResponseError(response: AxiosResponse): Error {
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
        errorMessage = `${JSON.stringify(response.data)}`;
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
    payload: SingleOrArray<Omit<Events[Event], "name">>
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
  public async send<Payload extends SingleOrArray<ValueOf<Events>>>(
    payload: Payload
  ): Promise<void>;
  public async send<Event extends keyof Events>(
    nameOrPayload: Event | SingleOrArray<ValueOf<Events>>,
    maybePayload?: SingleOrArray<Omit<Events[Event], "name">>
  ): Promise<void> {
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

    const response = await this.client.post(this.inngestApiUrl.href, payloads);

    if (response.status >= 200 && response.status < 300) {
      return;
    }

    throw this.#getResponseError(response);
  }

  /**
   * Given an event to listen to, run the given function when that event is
   * seen.
   */
  public createFunction<
    Event extends keyof Events,
    Name extends string,
    Fn extends StepFn<Events[Event], Name, "step">
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
    Fn extends StepFn<
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
    Fn extends StepFn<
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
      { step: new InngestStep(fn) }
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
    fn: StepFn<null, Name, "step">
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
    fn: StepFn<
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
    fn: StepFn<
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
      { step: new InngestStep(fn) }
    );
  }
}
