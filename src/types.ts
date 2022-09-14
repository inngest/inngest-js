import { InngestStep } from "./components/InngestStep";

export type StepFn<Event, FnId, StepId> = (arg: {
  event: Event;
  steps: {};
  ctx: { fn_id: FnId; step_id: StepId };
}) => any;

export interface EventPayload {
  /**
   * A unique identifier for the event
   */
  name: string;

  /**
   * Any data pertinent to the event
   */
  data: any;

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
export interface FunctionOptions<Name = string> {
  name: Name;
}

export type Steps = Record<string, InngestStep<any[], any>>;

export type StepRunResponse =
  | {
      status: 500;
      error?: string;
    }
  | {
      status: 200;
      body?: string;
    };

export interface RegisterPingResponse {
  /**
   * Response version, allowing Inngest to change any top-level field.
   */
  v: `${number}.${number}`;

  /**
   * SDK version from `package.json` for our internal metrics and to warn users
   * they need to upgrade.
   */
  sdk: `js:v${number}.${number}.${number}`;

  /**
   * The method used to deploy these functions.
   */
  deployType: "ping";

  /**
   * The name of the framework being used for this instance, e.g. "nextjs",
   * "vercel", "netlify", "lambda", etc. Uses the `framework` specified when
   * creating a new `InngestCommHandler`.
   */
  framework: string;

  /**
   * The name of this particular app, used for grouping and easier viewing in
   * the UI.
   */
  appName: string;

  /**
   * The functions available at this particular handler.
   */
  functions: FunctionConfig[];
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
        type: "http";
        url: string;
      };
    }
  >;
}
