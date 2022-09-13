import axios, { AxiosInstance, AxiosResponse } from "axios";
import * as InngestT from "../types";
import { InngestFunction } from "./InngestFunction";
import { InngestStep } from "./InngestStep";

/**
 * A client for the Inngest Source API
 */
export class Inngest<Events extends Record<string, any>> {
  public readonly name: string;

  /**
   * Inngest Source API Key
   */
  private readonly apiKey: string;

  /**
   * Full URL for the Inngest Source API
   */
  private readonly inngestBaseUrl: URL;
  private readonly inngestApiUrl: URL;
  private readonly inngestRegisterUrl: URL;

  /**
   * Axios configuration for sending events to Inngest
   */
  private readonly client: AxiosInstance;

  private readonly fns: Record<string, InngestFunction<Events>> = {};

  /**
   * @param apiKey - An API Key for the Inngest Source API
   */
  constructor(
    name: string,
    apiKey: string,
    { inngestBaseUrl = "https://inn.gs/" }: InngestT.ClientOptions = {}
  ) {
    this.name = name;
    this.apiKey = apiKey;
    this.inngestBaseUrl = new URL(inngestBaseUrl);
    this.inngestApiUrl = new URL(`e/${this.apiKey}`, this.inngestBaseUrl);
    this.inngestRegisterUrl = new URL("x/register", this.inngestBaseUrl);

    this.client = axios.create({
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "InngestJS 0.1.0",
      },
      validateStatus: () => true, // all status codes return a response
      maxRedirects: 0,
    });
  }

  #getResponseError(response: AxiosResponse): Error {
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
      | Omit<InngestT.EventPayload<Events[Event]>, "name">
      | Omit<InngestT.EventPayload<Events[Event]>, "name">[]
  ): Promise<boolean> {
    const response = await this.client.post(this.inngestApiUrl.href, {
      ...payload,
      name,
    });

    if (response.status >= 200 && response.status < 300) {
      return true;
    }

    throw this.#getResponseError(response);
  }

  /**
   * Respond to an incoming event.
   */
  public on<
    Event extends keyof Events,
    Fn extends (arg: { event: InngestT.EventPayload<Events[Event]> }) => any
  >(name: string, event: Event, fn: Fn): InngestFunction<Events>;
  public on<
    Event extends keyof Events,
    Fn extends (arg: { event: InngestT.EventPayload<Events[Event]> }) => any
  >(
    opts: InngestT.FunctionOptions,
    event: Event,
    fn: Fn
  ): InngestFunction<Events>;
  public on<
    Event extends keyof Events,
    Fn extends (arg: { event: InngestT.EventPayload<Events[Event]> }) => any
  >(
    opts: string | InngestT.FunctionOptions,
    event: Event,
    fn: Fn
  ): InngestFunction<Events> {
    return this.#addFunction(
      typeof opts === "string" ? { name: opts } : opts,
      event,
      {
        step: new InngestStep(this, fn),
      }
    );
  }

  #addFunction(
    opts: InngestT.FunctionOptions,
    trigger: keyof Events,
    steps: InngestT.Steps<Events>
  ): InngestFunction<Events> {
    if (Object.prototype.hasOwnProperty.call(this.fns, opts.name)) {
      throw new Error(
        `Cannot create two functions with the same name: "${opts.name}`
      );
    }

    const fn = new InngestFunction(this, opts, trigger, steps);
    this.fns[opts.name] = fn;

    return fn;
  }

  /**
   * Finds a function by `functionId` and runs the relevant step with the given
   * `stepId`.
   */
  private async runStep(
    functionId: string,
    stepId: string,
    data: any
  ): Promise<InngestT.StepRunResponse> {
    try {
      const fn = this.fns[functionId];
      if (!fn) {
        throw new Error(`Could not find function with ID "${functionId}"`);
      }

      const body = await fn["runStep"](stepId, data);

      return {
        status: 200,
        body: JSON.stringify(body),
      };
    } catch (err: any) {
      return {
        status: 500,
        error: err.stack || err.message,
      };
    }
  }
}
