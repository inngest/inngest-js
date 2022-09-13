import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { URL } from "url";

export declare namespace Inngest {
  /**
   * An HTTP-like, standardised response format that allows Inngest to help
   * orchestrate steps and retries.
   */
  export interface Response {
    /**
     * A step response must contain an HTTP status code.
     *
     * A `2xx` response indicates success; this is not a failure and no retry is
     * necessary.
     *
     * A `4xx` response indicates a bad request; this step will not be retried as
     * it is deemed irrecoverable. Examples of this might be an event with
     * insufficient data or concerning a user that no longer exists.
     *
     * A `5xx` status indicates a temporary internal error; this will be retried
     * according to the step and function's retry policy (3 times, by default).
     *
     * @link https://www.inngest.com/docs/functions/function-input-and-output#response-format
     * @link https://www.inngest.com/docs/functions/retries
     */
    status: number;

    /**
     * The output of the function - the `body` - can be any arbitrary
     * JSON-compatible data. It is then usable by any future steps.
     *
     * @link https://www.inngest.com/docs/functions/function-input-and-output#response-format
     */
    body?: any;
  }

  /**
   * A single step within a function.
   */
  export type Step<Context = any> = (
    /**
     * The context for this step, including the triggering event and any previous
     * step output.
     */
    context: Context
  ) => Promise<Response> | Response;

  /**
   * The event payload structure for sending data to Inngest
   */
  export interface EventPayload<Data = Record<string, any>> {
    /**
     * A unique identifier for the event
     */
    name: string;
    /**
     * Any data pertinent to the event
     */
    data: Data;
    /**
     * Any user data associated with the event
     * All fields ending in "_id" will be used to attribute the event to a particular user
     */
    user?: {
      /**
       * Your user's unique id in your system
       */
      external_id?: string;
      /**
       * Your user's email address
       */
      email?: string;
      /**
       * Your user's phone number
       */
      phone?: string;
      [key: string]: any;
    };
    /**
     * A specific event schema version
     * (optional)
     */
    v?: string;
    /**
     * An integer representing the milliseconds since the unix epoch at which this event occurred.
     * Defaults to the current time.
     * (optional)
     */
    ts?: number;
  }

  /**
   * A set of options for configuring the Inngest client
   */
  export interface ClientOptions {
    /**
     * The base Inngest Source API URL to append the Source API Key to.
     * Defaults to https://inn.gs/e/
     */
    inngestApiUrl?: string;
  }

  /**
   * A set of options for configuring an Inngest function.
   */
  export interface FunctionOptions {
    name: string;
  }

  export type Steps<Events extends Record<string, any>> = Record<
    string,
    InngestStep<Events, any[], any>
  >;
}

/**
 * A client for the Inngest Source API
 */
export class Inngest<Events extends Record<string, any>> {
  public readonly name: string;

  /**
   * Inngest Source API Key
   */
  readonly #apiKey: string;

  /**
   * Full URL for the Inngest Source API
   */
  private readonly inngestApiUrl: string;

  /**
   * Axios configuration for sending events to Inngest
   */
  readonly #axiosConfig: AxiosRequestConfig;

  #fns: InngestFunction<Events>[] = [];

  /**
   * @param apiKey - An API Key for the Inngest Source API
   */
  constructor(
    name: string,
    apiKey: string,
    { inngestApiUrl = "https://inn.gs/e/" }: Inngest.ClientOptions = {}
  ) {
    this.name = name;
    this.#apiKey = apiKey;
    this.inngestApiUrl = new URL(this.#apiKey, inngestApiUrl).toString();

    this.#axiosConfig = {
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "InngestJS 0.1.0",
      },
      validateStatus: () => true, // all status codes return a response
      maxRedirects: 0,
    };
  }

  private getResponseError(response: AxiosResponse): Error {
    let errorMessage = "Unknown error";
    switch (response.status) {
      case 401:
        errorMessage = "API Key Not Found";
        break;
      case 400:
        errorMessage = "Cannot process event payload";
        break;
      case 403:
        errorMessage = "Forbidden";
        break;
      case 404:
        errorMessage = "API Key not found";
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
   * Send event(s) to Inngest
   */
  public async send<Event extends keyof Events>(
    name: Event,
    payload:
      | Omit<Inngest.EventPayload<Events[Event]>, "name">
      | Omit<Inngest.EventPayload<Events[Event]>, "name">[]
  ): Promise<boolean> {
    const response = await axios.post(
      this.inngestApiUrl,
      {
        ...payload,
        name,
      },
      this.#axiosConfig
    );

    if (response.status >= 200 && response.status < 300) {
      return true;
    }

    throw this.getResponseError(response);
  }

  /**
   * Respond to an incoming event.
   */
  public on<
    Event extends keyof Events,
    Fn extends (arg: { event: Inngest.EventPayload<Events[Event]> }) => any
  >(name: string, event: Event, fn: Fn): InngestFunction<Events>;
  public on<
    Event extends keyof Events,
    Fn extends (arg: { event: Inngest.EventPayload<Events[Event]> }) => any
  >(
    opts: Inngest.FunctionOptions,
    event: Event,
    fn: Fn
  ): InngestFunction<Events>;
  public on<
    Event extends keyof Events,
    Fn extends (arg: { event: Inngest.EventPayload<Events[Event]> }) => any
  >(
    opts: string | Inngest.FunctionOptions,
    event: Event,
    fn: Fn
  ): InngestFunction<Events> {
    return this.#addFunction(
      new InngestFunction(
        this,
        typeof opts === "string" ? { name: opts } : opts,
        event,
        {
          step: new InngestStep(this, fn),
        }
      )
    );
  }

  #addFunction(fn: InngestFunction<Events>): typeof fn {
    this.#fns.push(fn);
    return fn;
  }

  /**
   * Register any functions under this Inngest instance.
   */
  public register() {}
}

class InngestFunction<Events extends Record<string, any>> {
  readonly #inngest: Inngest<Events>;
  readonly #opts: Inngest.FunctionOptions;
  readonly #trigger: keyof Events;
  readonly #steps: Inngest.Steps<Events>;

  constructor(
    inngest: Inngest<Events>,
    opts: Inngest.FunctionOptions,
    trigger: keyof Events,
    steps: Inngest.Steps<Events>
  ) {
    this.#inngest = inngest;
    this.#opts = opts;
    this.#trigger = trigger;
    this.#steps = steps;
  }

  private getConfig() {}
}

class InngestStep<
  Events extends Record<string, any>,
  Input extends any[],
  Output
> {
  readonly #inngest: Inngest<Events>;

  constructor(inngest: Inngest<Events>, fn: (...args: Input) => Output) {
    this.#inngest = inngest;
  }
}
