import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { URL } from "url";
import { Request, Response } from "express";
import { version } from "../package.json";
import { z } from "zod";

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
     * Defaults to https://inn.gs/
     */
    inngestBaseUrl?: string;
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
    { inngestBaseUrl = "https://inn.gs/" }: Inngest.ClientOptions = {}
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
      | Omit<Inngest.EventPayload<Events[Event]>, "name">
      | Omit<Inngest.EventPayload<Events[Event]>, "name">[]
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
      typeof opts === "string" ? { name: opts } : opts,
      event,
      {
        step: new InngestStep(this, fn),
      }
    );
  }

  #addFunction(
    opts: Inngest.FunctionOptions,
    trigger: keyof Events,
    steps: Inngest.Steps<Events>
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
  ): Promise<StepRunResponse> {
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

  public get name() {
    return this.#opts.name;
  }

  /**
   * Retrieve the Inngest config for this function.
   */
  private getConfig(
    /**
     * Must be provided a URL that will be used to trigger the step. This
     * function can't be expected to know how it will be accessed, so relies on
     * an outside method providing context.
     */
    url: URL
  ): FunctionConfig {
    return {
      id: this.#opts.name,
      name: this.#opts.name,
      triggers: [{ event: this.#trigger as string }],
      steps: Object.keys(this.#steps).reduce<FunctionConfig["steps"]>(
        (acc, stepId) => {
          return {
            ...acc,
            [stepId]: {
              id: stepId,
              name: stepId,
              runtime: {
                type: "remote",
                url: url.href,
              },
            },
          };
        },
        {}
      ),
    };
  }

  private runStep(stepId: string, data: any): Promise<unknown> {
    const step = this.#steps[stepId];
    if (!step) {
      throw new Error(
        `Could not find step with ID "${stepId}" in function "${this.name}"`
      );
    }

    return step["run"](data);
  }
}

class InngestStep<
  Events extends Record<string, any>,
  Input extends any[],
  Output
> {
  readonly #inngest: Inngest<Events>;
  readonly #fn: (...args: any) => Output;

  constructor(inngest: Inngest<Events>, fn: (...args: Input) => Output) {
    this.#inngest = inngest;
    this.#fn = fn;
  }

  private async run(data: any): Promise<unknown> {
    return this.#fn(data);
  }
}

export interface FunctionConfig {
  name: string;
  id: string;
  triggers: (
    | {
        event: string;
        expression?: string;
      }
    | {
        cron: string;
      }
  )[];
  steps: Record<
    string,
    {
      id: string;
      name: string;
      runtime: {
        type: "remote";
        url: string;
      };
    }
  >;
}

export const register = (
  inngestOrHandler: Inngest<any> | InngestCommHandler
) => {
  const handler =
    inngestOrHandler instanceof Inngest
      ? new InngestCommHandler(inngestOrHandler)
      : inngestOrHandler;

  return handler.createHandler();
};

export class InngestCommHandler {
  protected readonly frameworkName: string = "default";
  protected readonly inngest: Inngest<any>;

  constructor(inngest: Inngest<any>) {
    this.inngest = inngest;
  }

  public createHandler(): any {
    return async (req: Request, res: Response) => {
      console.log("Something hit the default handler!");

      const reqUrl = new URL(req.originalUrl, req.hostname);

      switch (req.method) {
        case "PUT":
          console.log("It was a PUT request");
          // Push config to Inngest.
          await this.register(reqUrl);
          return void res.sendStatus(200);

        case "GET":
          console.log("It was a GET request");
          // Inngest is asking for config; confirm signed and send.
          this.validateSignature(); //TODO
          const pingRes = this.pong(reqUrl);
          this.signResponse(); // TODO
          return void res.json(pingRes);

        case "POST":
          console.log("It was a POST request");
          // Inngest is trying to run a step; confirm signed and run.
          const { fnId, stepId } = z
            .object({
              fnId: z.string().min(1),
              stepId: z.string().min(1),
            })
            .parse({
              fnId: req.query.fnId,
              stepId: req.query.stepId,
            });

          const stepRes = await this.runStep(fnId, stepId, req.body);

          return void res.json(stepRes);

        default:
          return void res.sendStatus(405);
      }
    };
  }

  protected runStep(
    functionId: string,
    stepId: string,
    data: any
  ): Promise<StepRunResponse> {
    console.log(
      "Trying to run step",
      stepId,
      "in function",
      functionId,
      "with data",
      data
    );

    return this.inngest["runStep"](functionId, stepId, data);
  }

  protected configs(url: URL): FunctionConfig[] {
    return Object.values(this.inngest["fns"]).map((fn) => fn["getConfig"](url));
  }

  protected async register(url: URL): Promise<void> {
    const body = {
      url: url.href,
      hash: "TODO",
    };

    const config: AxiosRequestConfig = {
      headers: {
        Authorization: `Bearer ${this.inngest["apiKey"]}`,
      },
    };

    const res = await this.inngest["client"].post(
      this.inngest["inngestRegisterUrl"].href,
      body,
      config
    );

    console.log(
      "hit the register URL",
      this.inngest["inngestRegisterUrl"].href,
      "with:",
      body,
      "and",
      config,
      "and got back:",
      res.status,
      res.data
    );
  }

  protected pong(url: URL): RegisterPingResponse {
    return {
      ctx: {
        deployType: "ping",
        framework: this.frameworkName,
        name: this.inngest.name,
      },
      functions: this.configs(url),
      sdk: version,
      v: "0.1",
    };
  }

  protected validateSignature(): boolean {
    return true;
  }

  protected signResponse(): string {
    return "";
  }
}

class NextCommHandler extends InngestCommHandler {
  public override frameworkName = "nextjs";

  public override createHandler() {
    // this.
  }
}

interface RegisterPingResponse {
  /**
   * Response version, allowing Inngest to change any top-level field.
   */
  v: string;

  /**
   * SDK version from `package.json` for our internal metrics and to warn users
   * they need to upgrade.
   */
  sdk: string;

  ctx: {
    /**
     * The name of this particular app, used for grouping and easier viewing in
     * the UI.
     */
    name: string;

    /**
     * The name of the framework being used for this instance, e.g. "nextjs",
     * "vercel", "netlify", "lambda", etc. Uses the `framework` specified when
     * creating a new `InngestCommHandler`.
     */
    framework: string;

    /**
     * The method used to deploy these functions.
     */
    deployType: "ping";
  };

  /**
   * The functions available at this particular handler.
   */
  functions: FunctionConfig[];
}

type StepRunResponse =
  | {
      status: 500;
      error?: string;
    }
  | {
      status: 200;
      body?: string;
    };
