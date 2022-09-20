import { InngestStep } from "./components/InngestStep";

/**
 * The shape of a step function, taking in event, step, and ctx data, and
 * outputting anything.
 */
export type StepFn<Event, FnId, StepId> = (arg: {
  event: Event;
  steps: {};
  ctx: { fn_id: FnId; step_id: StepId };
}) => any;

/**
 * The shape of a single event's payload. It should be extended to enforce
 * adherence to given events and not used as a method of creating them (i.e. as
 * a generic).
 */
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

    /**
     * The user block can contain arbitrary data that you can use within your
     * own handlers too.
     */
    [key: string]: any;
  };

  /**
   * A specific event schema version
   * (optional)
   */
  v?: string;

  /**
   * An integer representing the milliseconds since the unix epoch at which this
   * event occurred.
   *
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
 * A set of options for configuring the Inngest client.
 */
export interface ClientOptions {
  /**
   * The base Inngest Source API URL to append the Source API Key to.
   * Defaults to https://inn.gs/
   */
  inngestBaseUrl?: string;
}

/**
 * A set of options for configuring the registration of Inngest functions.
 */
export interface RegisterOptions {
  /**
   * The URL used to register functions with Inngest.
   * Defaults to https://api.inngest.com/fn/register
   */
  inngestRegisterUrl?: string;
}

/**
 * A set of options for configuring an Inngest function.
 */
export interface FunctionOptions {
  /**
   * An optional unique ID used to identify the function. This is used
   * internally for versioning and referring to your function, so should not
   * change between deployments.
   *
   * By default, this is a slugified version of the given `name`, e.g.
   * `"My FN :)"` would be slugified to `"my-fn"`.
   *
   * If you are not specifying an ID and get a warning about duplicate
   * functions, make sure to explicitly set an ID for the duplicate or change
   * the name.
   */
  id?: string;

  /**
   * A name for the function as it will appear in the Inngest Cloud UI.
   *
   * This is used to create a slugified ID for the function too, e.g.
   * `"My FN :)"` would create a slugified ID of `"my-fn"`.
   *
   * If you are not specifying an ID and get a warning about duplicate
   * functions, make sure to explicitly set an ID for the duplicate or change
   * the name.
   */
  name: string;
}

/**
 * A shortcut type for a collection of Inngest steps.
 */
export type Steps = Record<string, InngestStep<any[], any>>;

/**
 * Expected responses to be used within an `InngestCommHandler` in order to
 * appropriately respond to Inngest.
 */
export type StepRunResponse =
  | {
      status: 500;
      error?: string;
    }
  | {
      status: 200;
      body?: any;
    };

/**
 * The response to send to Inngest when pushing function config either directly
 * or when pinged by Inngest Cloud.
 */
export interface RegisterRequest {
  /**
   * The API handler's URL to invoke SDK based functions.
   */
  url: string;

  /**
   * Response version, allowing Inngest to change any top-level field.
   */
  v: `${number}.${number}`;

  /**
   * SDK version from `package.json` for our internal metrics and to warn users
   * they need to upgrade.
   */
  sdk: `js:v${number}.${number}.${number}${"" | `-${string}.${number}`}`;

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

  /**
   * The hash of the current commit used to track deploys
   */
  hash?: string;
}

export type FunctionTrigger<T = string> =
  | {
      event: T;
      expression?: string;
    }
  | {
      cron: string;
    };
/**
 * A block representing an individual function being registered to Inngest
 * Cloud.
 */
export interface FunctionConfig {
  name: string;
  id: string;
  triggers: FunctionTrigger[];
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
