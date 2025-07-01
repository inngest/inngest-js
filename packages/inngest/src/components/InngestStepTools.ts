import { models, type AiAdapter } from "@inngest/ai";
import { z } from "zod";
import { logPrefix } from "../helpers/consts.js";
import { type Jsonify } from "../helpers/jsonify.js";
import { timeStr } from "../helpers/strings.js";
import * as Temporal from "../helpers/temporal.js";
import {
  type ExclusiveKeys,
  type ParametersExceptFirst,
  type SendEventPayload,
  type SimplifyDeep,
  type WithoutInternalStr,
} from "../helpers/types.js";
import {
  StepOpCode,
  type EventPayload,
  type HashedOp,
  type InvocationResult,
  type InvokeTargetFunctionDefinition,
  type MinimalEventPayload,
  type SendEventOutput,
  type StepOptions,
  type StepOptionsOrId,
  type TriggerEventFromFunction,
  type TriggersFromClient,
} from "../types.js";
import { type InngestExecution } from "./execution/InngestExecution.js";
import { fetch as stepFetch } from "./Fetch.js";
import {
  type ClientOptionsFromInngest,
  type GetEvents,
  type GetFunctionOutput,
  type GetStepTools,
  type Inngest,
} from "./Inngest.js";
import { InngestFunction } from "./InngestFunction.js";
import { InngestFunctionReference } from "./InngestFunctionReference.js";

export interface FoundStep extends HashedOp {
  hashedId: string;
  fn?: (...args: unknown[]) => unknown;
  rawArgs: unknown[];

  /**
   * A boolean representing whether the step has been fulfilled, either
   * resolving or rejecting the `Promise` returned to userland code.
   *
   * Note that this is distinct from {@link hasStepState}, which instead tracks
   * whether the step has been given some state from the Executor. State from
   * the Executor could be data other than a resolution or rejection, such as
   * inputs.
   */
  fulfilled: boolean;

  /**
   * A boolean representing whether the step has been given some state from the
   * Executor. State from the Executor could be data other than a resolution or
   * rejection, such as inputs.
   *
   * This is distinct from {@link fulfilled}, which instead tracks whether the
   * step has been fulfilled, either resolving or rejecting the `Promise`
   * returned to userland code.
   */
  hasStepState: boolean;

  handled: boolean;

  /**
   * The promise that has been returned to userland code for this step.
   */
  promise: Promise<unknown>;

  /**
   * Returns a boolean representing whether or not the step was handled on this
   * invocation.
   */
  handle: () => boolean;

  // TODO This is used to track the input we want for this step. Might be
  // present in ctx from Executor.
  input?: unknown;
}

export type MatchOpFn<
  T extends (...args: unknown[]) => Promise<unknown> = (
    ...args: unknown[]
  ) => Promise<unknown>,
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
  ) => Promise<unknown>,
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
export const createStepTools = <TClient extends Inngest.Any>(
  client: TClient,
  execution: InngestExecution,
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
   * Create a new step run tool that can be used to run a step function using
   * `step.run()` as a shim.
   */
  const createStepRun = (
    /**
     * The sub-type of this step tool, exposed via `opts.type` when the op is
     * reported.
     */
    type?: string
  ) => {
    return createTool<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <TFn extends (...args: any[]) => unknown>(
        idOrOptions: StepOptionsOrId,

        /**
         * The function to run when this step is executed. Can be synchronous or
         * asynchronous.
         *
         * The return value of this function will be the return value of this
         * call to `run`, meaning you can return and reason about return data
         * for next steps.
         */
        fn: TFn,

        /**
         * Optional input to pass to the function. If this is specified, Inngest
         * will keep track of the input for this step and be able to display it
         * in the UI.
         */
        ...input: Parameters<TFn>
      ) => Promise<
        /**
         * TODO Middleware can affect this. If run input middleware has returned
         * new step data, do not Jsonify.
         */
        SimplifyDeep<
          Jsonify<
            TFn extends (...args: Parameters<TFn>) => Promise<infer U>
              ? Awaited<U extends void ? null : U>
              : ReturnType<TFn> extends void
                ? null
                : ReturnType<TFn>
          >
        >
      >
    >(
      ({ id, name }, _fn, ...input) => {
        const opts: HashedOp["opts"] = {
          ...(input.length ? { input } : {}),
          ...(type ? { type } : {}),
        };

        return {
          id,
          op: StepOpCode.StepPlanned,
          name: id,
          displayName: name ?? id,
          ...(Object.keys(opts).length ? { opts } : {}),
        };
      },
      {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        fn: (_, fn, ...input) => fn(...input),
      }
    );
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
     * await step.sendEvent("emit-user-creation", {
     *   name: "app/user.created",
     *   data: { id: 123 },
     * });
     *
     * await step.sendEvent("emit-user-updates", [
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
      <Payload extends SendEventPayload<GetEvents<TClient>>>(
        idOrOptions: StepOptionsOrId,
        payload: Payload
      ): Promise<SendEventOutput<ClientOptionsFromInngest<TClient>>>;
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
        fn: (idOrOptions, payload) => {
          return client["_send"]({
            payload,
            headers: execution["options"]["headers"],
          });
        },
      }
    ),

    /**
     * EXPERIMENTAL: This API is not yet stable and may change in the future
     * without a major version bump.
     *
     * Wait for a particular signal to be received before continuing. When the
     * signal is received, its data will be returned.
     */
    waitForSignal: createTool<
      <TData>(
        idOrOptions: StepOptionsOrId,
        opts: WaitForSignalOpts
      ) => Promise<{ signal: string; data: Jsonify<TData> } | null>
    >(({ id, name }, opts) => {
      // TODO Should support Temporal.DurationLike, Temporal.InstantLike,
      // Temporal.ZonedDateTimeLike
      return {
        id,
        op: StepOpCode.WaitForSignal,
        name: opts.signal,
        displayName: name ?? id,
        opts: {
          signal: opts.signal,
          timeout: timeStr(opts.timeout),
          conflict: opts.onConflict,
        },
      };
    }),

    /**
     * Send a Signal to Inngest.
     */
    sendSignal: createTool<
      (idOrOptions: StepOptionsOrId, opts: SendSignalOpts) => Promise<null>
    >(
      ({ id, name }, opts) => {
        return {
          id,
          op: StepOpCode.StepPlanned,
          name: "sendSignal",
          displayName: name ?? id,
          opts: {
            type: "step.sendSignal",
            signal: opts.signal,
          },
        };
      },
      {
        fn: (_idOrOptions, opts) => {
          return client["_sendSignal"]({
            signal: opts.signal,
            data: opts.data,
            headers: execution["options"]["headers"],
          });
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
      <IncomingEvent extends WithoutInternalStr<TriggersFromClient<TClient>>>(
        idOrOptions: StepOptionsOrId,
        opts: WaitForEventOpts<GetEvents<TClient, true>, IncomingEvent>
      ) => Promise<
        IncomingEvent extends WithoutInternalStr<TriggersFromClient<TClient>>
          ? GetEvents<TClient, false>[IncomingEvent] | null
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
    run: createStepRun(),

    /**
     * AI tooling for running AI models and other AI-related tasks.
     */
    ai: {
      /**
       * Use this tool to have Inngest make your AI calls. Useful for agentic workflows.
       *
       * Input is also tracked for this tool, meaning you can pass input to the
       * function and it will be displayed and editable in the UI.
       */
      infer: createTool<
        <TAdapter extends AiAdapter>(
          idOrOptions: StepOptionsOrId,
          options: AiInferOpts<TAdapter>
        ) => Promise<AiAdapter.Output<TAdapter>>
      >(({ id, name }, options) => {
        const modelCopy = { ...options.model };

        // Allow the model to mutate options and body for this call
        options.model.onCall?.(modelCopy, options.body);

        return {
          id,
          op: StepOpCode.AiGateway,
          displayName: name ?? id,
          opts: {
            type: "step.ai.infer",
            url: modelCopy.url,
            headers: modelCopy.headers,
            auth_key: modelCopy.authKey,
            format: modelCopy.format,
            body: options.body,
          },
        };
      }),

      /**
       * Use this tool to wrap AI models and other AI-related tasks. Each call
       * to `wrap` will be retried individually, meaning you can compose complex
       * workflows that safely retry dependent asynchronous actions.
       *
       * Input is also tracked for this tool, meaning you can pass input to the
       * function and it will be displayed and editable in the UI.
       */
      wrap: createStepRun("step.ai.wrap"),

      /**
       * Models for AI inference and other AI-related tasks.
       */
      models: {
        ...models,
      },
    },

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
        time: number | string | Temporal.DurationLike
      ) => Promise<void>
    >(({ id, name }, time) => {
      /**
       * The presence of this operation in the returned stack indicates that the
       * sleep is over and we should continue execution.
       */
      const msTimeStr: string = timeStr(
        Temporal.isTemporalDuration(time)
          ? time.total({ unit: "milliseconds" })
          : (time as number | string)
      );

      return {
        id,
        op: StepOpCode.Sleep,
        name: msTimeStr,
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
        time: Date | string | Temporal.InstantLike | Temporal.ZonedDateTimeLike
      ) => Promise<void>
    >(({ id, name }, time) => {
      try {
        const iso = Temporal.getISOString(time);

        /**
         * The presence of this operation in the returned stack indicates that the
         * sleep is over and we should continue execution.
         */
        return {
          id,
          op: StepOpCode.Sleep,
          name: iso,
          displayName: name ?? id,
        };
      } catch (err) {
        /**
         * If we're here, it's because the date is invalid. We'll throw a custom
         * error here to standardise this response.
         */
        // TODO PrettyError
        console.warn(
          "Invalid `Date`, date string, `Temporal.Instant`, or `Temporal.ZonedDateTime` passed to sleepUntil;",
          err
        );

        // TODO PrettyError
        throw new Error(
          `Invalid \`Date\`, date string, \`Temporal.Instant\`, or \`Temporal.ZonedDateTime\` passed to sleepUntil: ${
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            time as any
          }`
        );
      }
    }),

    /**
     * Invoke a passed Inngest `function` with the given `data`. Returns the
     * result of the returned value of the function or `null` if the function
     * does not return a value.
     *
     * A string ID can also be passed to reference functions outside of the
     * current app.
     */
    invoke: createTool<
      <TFunction extends InvokeTargetFunctionDefinition>(
        idOrOptions: StepOptionsOrId,
        opts: InvocationOpts<TFunction>
      ) => InvocationResult<GetFunctionOutput<TFunction>>
    >(({ id, name }, invokeOpts) => {
      // Create a discriminated union to operate on based on the input types
      // available for this tool.
      const optsSchema = invokePayloadSchema.extend({
        timeout: z.union([z.number(), z.string(), z.date()]).optional(),
      });

      const parsedFnOpts = optsSchema
        .extend({
          _type: z.literal("fullId").optional().default("fullId"),
          function: z.string().min(1),
        })
        .or(
          optsSchema.extend({
            _type: z.literal("fnInstance").optional().default("fnInstance"),
            function: z.instanceof(InngestFunction),
          })
        )
        .or(
          optsSchema.extend({
            _type: z.literal("refInstance").optional().default("refInstance"),
            function: z.instanceof(InngestFunctionReference),
          })
        )
        .safeParse(invokeOpts);

      if (!parsedFnOpts.success) {
        throw new Error(
          `Invalid invocation options passed to invoke; must include either a function or functionId.`
        );
      }

      const { _type, function: fn, data, user, v, timeout } = parsedFnOpts.data;
      const payload = { data, user, v } satisfies MinimalEventPayload;
      const opts: {
        payload: MinimalEventPayload;
        function_id: string;
        timeout?: string;
      } = {
        payload,
        function_id: "",
        timeout: typeof timeout === "undefined" ? undefined : timeStr(timeout),
      };

      switch (_type) {
        case "fnInstance":
          opts.function_id = fn.id(fn["client"].id);
          break;

        case "fullId":
          console.warn(
            `${logPrefix} Invoking function with \`function: string\` is deprecated and will be removed in v4.0.0; use an imported function or \`referenceFunction()\` instead. See https://innge.st/ts-referencing-functions`
          );
          opts.function_id = fn;
          break;

        case "refInstance":
          opts.function_id = [fn.opts.appId || client.id, fn.opts.functionId]
            .filter(Boolean)
            .join("-");
          break;
      }

      return {
        id,
        op: StepOpCode.InvokeFunction,
        displayName: name ?? id,
        opts,
      };
    }),

    /**
     * `step.fetch` is a Fetch-API-compatible function that can be used to make
     * any HTTP code durable if it's called within an Inngest function.
     *
     * It will gracefully fall back to the global `fetch` if called outside of
     * this context, and a custom fallback can be set using the `config` method.
     */
    fetch: stepFetch,
  };

  // Add an uptyped gateway
  (tools as unknown as InternalStepTools)[gatewaySymbol] = createTool(
    ({ id, name }, input, init) => {
      const url = input instanceof Request ? input.url : input.toString();

      const headers: Record<string, string> = {};
      if (input instanceof Request) {
        input.headers.forEach((value, key) => (headers[key] = value));
      } else if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((value, key) => (headers[key] = value));
      }

      return {
        id,
        op: StepOpCode.Gateway,
        displayName: name ?? id,
        opts: {
          url,
          method: init?.method ?? "GET",
          headers,
          body: init?.body,
        },
      };
    }
  );

  return tools;
};

export const gatewaySymbol = Symbol.for("inngest.step.gateway");

export type InternalStepTools = GetStepTools<Inngest.Any> & {
  [gatewaySymbol]: (
    idOrOptions: StepOptionsOrId,
    ...args: Parameters<typeof fetch>
  ) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
};

/**
 * The event payload portion of the options for `step.invoke()`. This does not
 * include non-payload options like `timeout` or the function to invoke.
 */
export const invokePayloadSchema = z.object({
  data: z.record(z.any()).optional(),
  user: z.record(z.any()).optional(),
  v: z.string().optional(),
});

type InvocationTargetOpts<TFunction extends InvokeTargetFunctionDefinition> = {
  function: TFunction;
};

type InvocationOpts<TFunction extends InvokeTargetFunctionDefinition> =
  InvocationTargetOpts<TFunction> &
    Omit<TriggerEventFromFunction<TFunction>, "id"> & {
      /**
       * The step function will wait for the invocation to finish for a maximum
       * of this time, at which point the retured promise will be rejected
       * instead of resolved with the output of the invoked function.
       *
       * Note that the invoked function will continue to run even if this step
       * times out.
       *
       * The time to wait can be specified using a `number` of milliseconds, an
       * `ms`-compatible time string like `"1 hour"`, `"30 mins"`, or `"2.5d"`,
       * or a `Date` object.
       *
       * {@link https://npm.im/ms}
       */
      timeout?: number | string | Date;
    };

/**
 * A set of parameters given to a `sendSignal` call.
 */
type SendSignalOpts = {
  /**
   * The signal to send.
   */
  signal: string;

  /**
   * The data to send with the signal.
   */
  data?: unknown;
};

/**
 * A set of parameters given to a `waitForSignal` call.
 */
type WaitForSignalOpts = {
  /**
   * The signal to wait for.
   */
  signal: string;

  /**
   * The step function will wait for the signal for a maximum of this time, at
   * which point the signal will be returned as `null` instead of any signal
   * data.
   *
   * The time to wait can be specified using a `number` of milliseconds, an
   * `ms`-compatible time string like `"1 hour"`, `"30 mins"`, or `"2.5d"`, or
   * a `Date` object.
   *
   * {@link https://npm.im/ms}
   */
  timeout: number | string | Date;

  /**
   * When this `step.waitForSignal()` call is made, choose whether an existing
   * wait for the same signal should be replaced, or whether this run should
   * fail.
   *
   * `"replace"` will replace any existing wait with this one, and the existing
   * wait will remain pending until it reaches its timeout.
   *
   * `"fail"` will cause this run to fail if there is already a wait for the
   * same signal.
   */
  onConflict: "replace" | "fail";
};

/**
 * A set of optional parameters given to a `waitForEvent` call to control how
 * the event is handled.
 */
type WaitForEventOpts<
  Events extends Record<string, EventPayload>,
  IncomingEvent extends keyof Events,
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
     *
     * @deprecated Use `if` instead.
     */
    match?: string;

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

/**
 * Options for `step.ai.infer()`.
 */
type AiInferOpts<TModel extends AiAdapter> = {
  /**
   * The model to use for the inference. Create a model by importing from
   * `"inngest"` or by using `step.ai.models.*`.
   *
   * @example Import `openai()`
   * ```ts
   * import { openai } from "inngest";
   *
   * const model = openai({ model: "gpt-4" });
   * ```
   *
   * @example Use a model from `step.ai.models`
   * ```ts
   * async ({ step }) => {
   *            const model = step.ai.models.openai({ model: "gpt-4" });
   * }
   * ```
   */
  model: TModel;

  /**
   * The input to pass to the model.
   */
  body: AiAdapter.Input<TModel>;
};
