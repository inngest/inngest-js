import { type Jsonify } from "type-fest";
import { timeStr } from "../helpers/strings";
import {
  type ExclusiveKeys,
  type ObjectPaths,
  type ParametersExceptFirst,
  type SendEventPayload,
} from "../helpers/types";
import {
  StepOpCode,
  type ClientOptions,
  type EventPayload,
  type HashedOp,
  type SendEventOutput,
  type StepOptions,
  type StepOptionsOrId,
} from "../types";
import { type EventsFromOpts, type Inngest } from "./Inngest";

export interface FoundStep extends HashedOp {
  hashedId: string;
  fn?: (...args: unknown[]) => unknown;
  fulfilled: boolean;
  handled: boolean;

  /**
   * Returns a boolean representing whether or not the step was handled on this
   * invocation.
   */
  handle: () => boolean;
}

export type MatchOpFn<
  T extends (...args: unknown[]) => Promise<unknown> = (
    ...args: unknown[]
  ) => Promise<unknown>
> = (
  stepOptions: StepOptions,
  /**
   * Arguments passed by the user.
   */
  ...args: ParametersExceptFirst<T>
) => Omit<HashedOp, "data" | "error">;

export type StepHandler = (info: {
  matchOp: MatchOpFn;
  opts?: StepToolOptions;
  args: [StepOptionsOrId, ...unknown[]];
}) => Promise<unknown>;

export interface StepToolOptions<
  T extends (...args: unknown[]) => Promise<unknown> = (
    ...args: unknown[]
  ) => Promise<unknown>
> {
  /**
   * Optionally, we can also provide a function that will be called when
   * Inngest tells us to run this operation.
   *
   * If this function is defined, the first time the tool is used it will
   * report the desired operation (including options) to the Inngest. Inngest
   * will then call back to the function to tell it to run the step and then
   * retrieve data.
   *
   * We do this in order to allow functionality such as per-step retries; this
   * gives the SDK the opportunity to tell Inngest what it wants to do before
   * it does it.
   *
   * This function is passed the arguments passed by the user. It will be run
   * when we receive an operation matching this one that does not contain a
   * `data` property.
   */
  fn?: (...args: Parameters<T>) => unknown;

  /**
   * If `true` and we have detected that this is a  non-step function, the
   * provided `fn` will be called and the result returned immediately
   * instead of being executed later.
   *
   * If no `fn` is provided to the tool, this will throw the same error as
   * if this setting was `false`.
   */
  nonStepExecuteInline?: boolean;
}

export const getStepOptions = (options: StepOptionsOrId): StepOptions => {
  if (typeof options === "string") {
    return { id: options };
  }

  return options;
};

/**
 * Suffix used to namespace steps that are automatically indexed.
 */
export const STEP_INDEXING_SUFFIX = ":";

/**
 * Create a new set of step function tools ready to be used in a step function.
 * This function should be run and a fresh set of tools provided every time a
 * function is run.
 *
 * An op stack (function state) is passed in as well as some mutable properties
 * that the tools can use to submit a new op.
 */
export const createStepTools = <
  TOpts extends ClientOptions,
  Events extends EventsFromOpts<TOpts>,
  TriggeringEvent extends keyof Events & string
>(
  client: Inngest<TOpts>,
  stepHandler: StepHandler
) => {
  /**
   * A local helper used to create tools that can be used to submit an op.
   *
   * When using this function, a generic type should be provided which is the
   * function signature exposed to the user.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createTool = <T extends (...args: any[]) => Promise<unknown>>(
    /**
     * A function that returns an ID for this op. This is used to ensure that
     * the op stack is correctly filled, submitted, and retrieved with the same
     * ID.
     *
     * It is passed the arguments passed by the user.
     *
     * Most simple tools will likely only need to define this.
     */
    matchOp: MatchOpFn<T>,
    opts?: StepToolOptions<T>
  ): T => {
    return (async (...args: Parameters<T>): Promise<unknown> => {
      const parsedArgs = args as unknown as [StepOptionsOrId, ...unknown[]];
      return stepHandler({ args: parsedArgs, matchOp, opts });
    }) as T;
  };

  /**
   * Define the set of tools the user has access to for their step functions.
   *
   * Each key is the function name and is expected to run `createTool` and pass
   * a generic type for that function as it will appear in the user's code.
   */
  const tools = {
    /**
     * Send one or many events to Inngest. Should always be used in place of
     * `inngest.send()` to ensure that the event send is successfully retried
     * and not sent multiple times due to memoisation.
     *
     * @example
     * ```ts
     * await step.sendEvent("app/user.created", { data: { id: 123 } });
     *
     * await step.sendEvent({ name: "app/user.created", data: { id: 123 } });
     *
     * await step.sendEvent([
     *   {
     *     name: "app/user.created",
     *     data: { id: 123 },
     *   },
     *   {
     *     name: "app/user.feed.created",
     *     data: { id: 123 },
     *   },
     * ]);
     * ```
     *
     * Returns a promise that will resolve once the event has been sent.
     */
    sendEvent: createTool<{
      <Payload extends SendEventPayload<EventsFromOpts<TOpts>>>(
        idOrOptions: StepOptionsOrId,
        payload: Payload
      ): Promise<SendEventOutput<TOpts>>;
    }>(
      ({ id, name }) => {
        return {
          id,
          op: StepOpCode.StepPlanned,
          name: "sendEvent",
          displayName: name ?? id,
        };
      },
      {
        nonStepExecuteInline: true,
        fn: (idOrOptions, payload) => {
          return client.send(payload);
        },
      }
    ),

    /**
     * Wait for a particular event to be received before continuing. When the
     * event is received, it will be returned.
     *
     * You can also provide options to control the particular event that is
     * received, for example to ensure that a user ID matches between two
     * events, or to only wait a maximum amount of time before giving up and
     * returning `null` instead of any event data.
     */
    waitForEvent: createTool<
      <IncomingEvent extends keyof Events & string>(
        idOrOptions: StepOptionsOrId,
        opts: WaitForEventOpts<Events, TriggeringEvent, IncomingEvent>
      ) => Promise<
        IncomingEvent extends keyof Events
          ? Events[IncomingEvent] | null
          : IncomingEvent | null
      >
    >(
      (
        { id, name },

        /**
         * Options to control the event we're waiting for.
         */
        opts
      ) => {
        const matchOpts: { timeout: string; if?: string } = {
          timeout: timeStr(typeof opts === "string" ? opts : opts.timeout),
        };

        if (typeof opts !== "string") {
          if (opts?.match) {
            matchOpts.if = `event.${opts.match} == async.${opts.match}`;
          } else if (opts?.if) {
            matchOpts.if = opts.if;
          }
        }

        return {
          id,
          op: StepOpCode.WaitForEvent,
          name: opts.event,
          opts: matchOpts,
          displayName: name ?? id,
        };
      }
    ),

    /**
     * Use this tool to run business logic. Each call to `run` will be retried
     * individually, meaning you can compose complex workflows that safely
     * retry dependent asynchronous actions.
     *
     * The function you pass to `run` will be called only when this "step" is to
     * be executed and can be synchronous or asynchronous.
     *
     * In either case, the return value of the function will be the return value
     * of the `run` tool, meaning you can return and reason about return data
     * for next steps.
     */
    run: createTool<
      <T extends () => unknown>(
        idOrOptions: StepOptionsOrId,

        /**
         * The function to run when this step is executed. Can be synchronous or
         * asynchronous.
         *
         * The return value of this function will be the return value of this
         * call to `run`, meaning you can return and reason about return data
         * for next steps.
         */
        fn: T
      ) => Promise<
        /**
         * TODO Middleware can affect this. If run input middleware has returned
         * new step data, do not Jsonify.
         */
        Jsonify<
          T extends () => Promise<infer U>
            ? Awaited<U extends void ? null : U>
            : ReturnType<T> extends void
            ? null
            : ReturnType<T>
        >
      >
    >(
      ({ id, name }) => {
        return {
          id,
          op: StepOpCode.StepPlanned,
          name: id,
          displayName: name ?? id,
        };
      },
      { fn: (stepOptions, fn) => fn() }
    ),

    /**
     * Wait a specified amount of time before continuing.
     *
     * The time to wait can be specified using a `number` of milliseconds or an
     * `ms`-compatible time string like `"1 hour"`, `"30 mins"`, or `"2.5d"`.
     *
     * {@link https://npm.im/ms}
     *
     * To wait until a particular date, use `sleepUntil` instead.
     */
    sleep: createTool<
      (
        idOrOptions: StepOptionsOrId,

        /**
         * The amount of time to wait before continuing.
         */
        time: number | string
      ) => Promise<void>
    >(({ id, name }, time) => {
      /**
       * The presence of this operation in the returned stack indicates that the
       * sleep is over and we should continue execution.
       */
      return {
        id,
        op: StepOpCode.Sleep,
        name: timeStr(time),
        displayName: name ?? id,
      };
    }),

    /**
     * Wait until a particular date before continuing by passing a `Date`.
     *
     * To wait for a particular amount of time from now, always use `sleep`
     * instead.
     */
    sleepUntil: createTool<
      (
        idOrOptions: StepOptionsOrId,

        /**
         * The date to wait until before continuing.
         */
        time: Date | string
      ) => Promise<void>
    >(({ id, name }, time) => {
      const date = typeof time === "string" ? new Date(time) : time;

      /**
       * The presence of this operation in the returned stack indicates that the
       * sleep is over and we should continue execution.
       */
      try {
        return {
          id,
          op: StepOpCode.Sleep,
          name: date.toISOString(),
          displayName: name ?? id,
        };
      } catch (err) {
        /**
         * If we're here, it's because the date is invalid. We'll throw a custom
         * error here to standardise this response.
         */
        // TODO PrettyError
        console.warn("Invalid date or date string passed to sleepUntil;", err);

        // TODO PrettyError
        throw new Error(
          `Invalid date or date string passed to sleepUntil: ${time.toString()}`
        );
      }
    }),
  };

  return tools;
};

/**
 * A set of optional parameters given to a `waitForEvent` call to control how
 * the event is handled.
 */
type WaitForEventOpts<
  Events extends Record<string, EventPayload>,
  TriggeringEvent extends keyof Events,
  IncomingEvent extends keyof Events
> = {
  event: IncomingEvent;

  /**
   * The step function will wait for the event for a maximum of this time, at
   * which point the event will be returned as `null` instead of any event data.
   *
   * The time to wait can be specified using a `number` of milliseconds, an
   * `ms`-compatible time string like `"1 hour"`, `"30 mins"`, or `"2.5d"`, or
   * a `Date` object.
   *
   * {@link https://npm.im/ms}
   */
  timeout: number | string | Date;
} & ExclusiveKeys<
  {
    /**
     * If provided, the step function will wait for the incoming event to match
     * particular criteria. If the event does not match, it will be ignored and
     * the step function will wait for another event.
     *
     * It must be a string of a dot-notation field name within both events to
     * compare, e.g. `"data.id"` or `"user.email"`.
     *
     * ```
     * // Wait for an event where the `user.email` field matches
     * match: "user.email"
     * ```
     *
     * All of these are helpers for the `if` option, which allows you to specify
     * a custom condition to check. This can be useful if you need to compare
     * multiple fields or use a more complex condition.
     *
     * See the Inngest expressions docs for more information.
     *
     * {@link https://www.inngest.com/docs/functions/expressions}
     */
    match?: ObjectPaths<Events[TriggeringEvent]> &
      ObjectPaths<Events[IncomingEvent]>;

    /**
     * If provided, the step function will wait for the incoming event to match
     * the given condition. If the event does not match, it will be ignored and
     * the step function will wait for another event.
     *
     * The condition is a string of Google's Common Expression Language. For most
     * simple cases, you might prefer to use `match` instead.
     *
     * See the Inngest expressions docs for more information.
     *
     * {@link https://www.inngest.com/docs/functions/expressions}
     */
    if?: string;
  },
  "match",
  "if"
>;
