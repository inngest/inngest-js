import { type AiAdapter, models } from "@inngest/ai";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod/v3";

import type { Jsonify } from "../helpers/jsonify.ts";
import { timeStr } from "../helpers/strings.ts";
import * as Temporal from "../helpers/temporal.ts";
import type {
  ExclusiveKeys,
  ParametersExceptFirst,
  SendEventPayload,
} from "../helpers/types.ts";
import {
  type ApplyAllMiddlewareTransforms,
  type Context,
  type EventPayload,
  type HashedOp,
  type InvocationResult,
  type InvokeTargetFunctionDefinition,
  type MinimalEventPayload,
  type SendEventOutput,
  StepMode,
  StepOpCode,
  type StepOptions,
  type StepOptionsOrId,
  type TriggerEventFromFunction,
} from "../types.ts";
import { getAsyncCtx, getAsyncCtxSync } from "./execution/als.ts";
import type { InngestExecution } from "./execution/InngestExecution.ts";
import { fetch as stepFetch } from "./Fetch.ts";
import type {
  ClientOptionsFromInngest,
  GetFunctionOutputRaw,
  GetStepTools,
  Inngest,
} from "./Inngest.ts";
import { InngestFunction } from "./InngestFunction.ts";
import { InngestFunctionReference } from "./InngestFunctionReference.ts";
import {
  type MetadataBuilder,
  type MetadataStepTool,
  metadataSymbol,
  UnscopedMetadataBuilder,
} from "./InngestMetadata.ts";
import type { Middleware } from "./middleware/index.ts";
import type { Realtime } from "./realtime/types.ts";
import type { EventType } from "./triggers/triggers.ts";

/**
 * Middleware context for a step, created during step registration.
 *
 * Uses a "deferred handler" pattern: the `wrapStep` middleware chain starts
 * during discovery (so middleware can inject its own steps), but the real
 * handler isn't known until after the memoization lookup. `setActualHandler`
 * bridges the gap — the chain blocks on a deferred promise that is resolved
 * once `executeStep` determines the real result.
 */
export interface StepMiddlewareContext {
  /**
   * Sets the handler that the middleware pipeline will eventually call.
   * Called after memoization lookup to set either:
   * - A handler returning memoized data, OR
   * - A handler executing the step fresh
   */
  setActualHandler: (handler: () => Promise<unknown>) => void;

  /**
   * Step info after middleware transformations. The `options.id` may differ
   * from the original if middleware modified it via `transformStepInput`.
   */
  stepInfo: Middleware.StepInfo;

  /**
   * The middleware pipeline entry point. Call this to execute the step
   * through all middleware transformations.
   */
  wrappedHandler: () => Promise<unknown>;
}

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

  /**
   * Middleware context for this step. Holds the `wrapStep` chain entry point
   * and the deferred handler setter used by `executeStep`.
   */
  middleware: StepMiddlewareContext;

  /**
   * For new steps where wrappedHandler is called during discovery,
   * this holds the resolve/reject to be called when the step's data is
   * memoized. Resolved with server-transformed data (post-wrapStepHandler),
   * which unblocks wrapStep's `next()`.
   *
   * Is undefined when any of the following is true:
   * - The step is fulfilled
   * - The step has no handler (`step.sleep`, `step.waitForSignal`, etc.)
   */
  memoizationDeferred?: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };

  /**
   * For new steps where `wrappedHandler` is called during discovery, this holds
   * the promise for the wrapStep-transformed result. In checkpointing mode,
   * handle() reuses this promise to avoid a duplicate wrapStep call.
   */
  transformedResultPromise?: Promise<unknown>;
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
  fn?: (...args: [Context.Any, ...Parameters<T>]) => unknown;
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
/**
 * Merge client-level and function-level middleware into a single array type
 * for use with ApplyAllMiddlewareTransforms etc.
 */
type MergedMiddleware<
  TClient extends Inngest.Any,
  TFnMiddleware extends Middleware.Class[] | undefined,
> = [
  ...(ClientOptionsFromInngest<TClient>["middleware"] extends Middleware.Class[]
    ? ClientOptionsFromInngest<TClient>["middleware"]
    : []),
  ...(TFnMiddleware extends Middleware.Class[] ? TFnMiddleware : []),
];

export const createStepTools = <
  TClient extends Inngest.Any,
  TFnMiddleware extends Middleware.Class[] | undefined = undefined,
>(
  client: TClient,
  execution: InngestExecution,
  stepHandler: StepHandler,
) => {
  /**
   * A local helper used to create tools that can be used to submit an op.
   *
   * When using this function, a generic type should be provided which is the
   * function signature exposed to the user.
   */
  // biome-ignore lint/suspicious/noExplicitAny: intentional
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
    opts?: StepToolOptions<T>,
  ): T => {
    const wrappedMatchOp: MatchOpFn<T> = (stepOptions, ...rest) => {
      const op = matchOp(stepOptions, ...rest);

      // Explicit option takes precedence, then check ALS context
      const parallelMode =
        stepOptions.parallelMode ?? getAsyncCtxSync()?.execution?.parallelMode;

      if (parallelMode) {
        op.opts = { ...op.opts, parallelMode };
      }

      return op;
    };

    return (async (...args: Parameters<T>): Promise<unknown> => {
      const parsedArgs = args as unknown as [StepOptionsOrId, ...unknown[]];
      return stepHandler({ args: parsedArgs, matchOp: wrappedMatchOp, opts });
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
    type?: string,
  ) => {
    return createTool<
      // biome-ignore lint/suspicious/noExplicitAny: intentional
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
        ApplyAllMiddlewareTransforms<
          MergedMiddleware<TClient, TFnMiddleware>,
          TFn extends (...args: Parameters<TFn>) => Promise<infer U>
            ? Awaited<U extends void ? null : U>
            : ReturnType<TFn> extends void
              ? null
              : ReturnType<TFn>
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
          mode: StepMode.Sync,
          op: StepOpCode.StepPlanned,
          name: id,
          displayName: name ?? id,
          ...(Object.keys(opts).length ? { opts } : {}),
          userland: { id },
        };
      },
      {
        fn: (_, __, fn, ...input) => fn(...input),
      },
    );
  };

  /**
   * Creates a metadata builder wrapper for step.metadata("id").
   * Uses MetadataBuilder for config accumulation, but wraps .update() in tools.run() for memoization.
   */
  const createStepMetadataWrapper = (
    memoizationId: string,
    builder?: UnscopedMetadataBuilder,
  ) => {
    if (!client["experimentalMetadataEnabled"]) {
      throw new Error(
        'step.metadata() is experimental. Enable it by adding metadataMiddleware() from "inngest/experimental" to your client middleware.',
      );
    }
    const withBuilder = (next: UnscopedMetadataBuilder) =>
      createStepMetadataWrapper(memoizationId, next);

    if (!builder) {
      builder = new UnscopedMetadataBuilder(client).run();
    }

    return {
      run: (runId?: string) => withBuilder(builder.run(runId)),
      step: (stepId: string, index?: number) =>
        withBuilder(builder.step(stepId, index)),
      attempt: (attemptIndex: number) =>
        withBuilder(builder.attempt(attemptIndex)),
      span: (spanId: string) => withBuilder(builder.span(spanId)),
      update: async (
        values: Record<string, unknown>,
        kind = "default",
      ): Promise<void> => {
        await tools.run(memoizationId, async () => {
          await builder.update(values, kind);
        });
      },

      do: async (
        fn: (builder: MetadataBuilder) => Promise<void>,
      ): Promise<void> => {
        await tools.run(memoizationId, async () => {
          await fn(builder);
        });
      },
    };
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
    sendEvent: createTool<
      (
        idOrOptions: StepOptionsOrId,
        payload: SendEventPayload,
      ) => Promise<SendEventOutput<ClientOptionsFromInngest<TClient>>>
    >(
      ({ id, name }) => {
        return {
          id,
          mode: StepMode.Sync,
          op: StepOpCode.StepPlanned,
          name: "sendEvent",
          displayName: name ?? id,
          opts: {
            type: "step.sendEvent",
          },
          userland: { id },
        };
      },
      {
        fn: (_ctx, _idOrOptions, payload) => {
          const fn = execution["options"]["fn"];
          return client["_send"]({
            payload,
            headers: execution["options"]["headers"],
            fnMiddleware: fn.opts.middleware ?? [],
            fnInfo: { id: fn.opts.id },
          });
        },
      },
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
        opts: WaitForSignalOpts,
      ) => Promise<{ signal: string; data: Jsonify<TData> } | null>
    >(({ id, name }, opts) => {
      // TODO Should support Temporal.DurationLike, Temporal.InstantLike,
      // Temporal.ZonedDateTimeLike
      return {
        id,
        mode: StepMode.Async,
        op: StepOpCode.WaitForSignal,
        name: opts.signal,
        displayName: name ?? id,
        opts: {
          signal: opts.signal,
          timeout: timeStr(opts.timeout),
          conflict: opts.onConflict,
        },
        userland: { id },
      };
    }),

    /**
     * Step-level functionality related to realtime features.
     *
     * Unlike client-level realtime methods (`inngest.realtime.*`), these tools
     * will be their own durable steps when run. If you wish to use realtime
     * features outside of a step, make sure to use the client-level methods
     * instead.
     */
    realtime: {
      /**
       * Publish a realtime message to a particular topic and channel as a step.
       */
      publish: createTool<
        <TMessage extends Realtime.Message.Input>(
          idOrOptions: StepOptionsOrId,
          opts: TMessage,
        ) => Promise<Awaited<TMessage>["data"]>
      >(
        ({ id, name }) => {
          return {
            id,
            mode: StepMode.Sync,
            op: StepOpCode.StepPlanned,
            displayName: name ?? id,
            opts: {
              type: "step.realtime.publish",
            },
            userland: { id },
          };
        },
        {
          fn: (ctx, _idOrOptions, opts) => {
            return client["inngestApi"].publish(
              {
                topics: [opts.topic],
                channel: opts.channel,
                runId: ctx.runId,
              },
              opts.data,
            );
          },
        },
      ),
    },

    /**
     * Send a Signal to Inngest.
     */
    sendSignal: createTool<
      (idOrOptions: StepOptionsOrId, opts: SendSignalOpts) => Promise<null>
    >(
      ({ id, name }, opts) => {
        return {
          id,
          mode: StepMode.Sync,
          op: StepOpCode.StepPlanned,
          name: "sendSignal",
          displayName: name ?? id,
          opts: {
            type: "step.sendSignal",
            signal: opts.signal,
          },
          userland: { id },
        };
      },
      {
        fn: (_ctx, _idOrOptions, opts) => {
          return client["_sendSignal"]({
            signal: opts.signal,
            data: opts.data,
            headers: execution["options"]["headers"],
          });
        },
      },
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
      <
        TOpts extends {
          /**
           * The event to wait for.
           */
          event:
            | string
            // biome-ignore lint/suspicious/noExplicitAny: Allow any schema
            | EventType<string, any>;

          /**
           * The step function will wait for the event for a maximum of this
           * time, at which point the signal will be returned as `null` instead
           * of any signal data.
           *
           * The time to wait can be specified using a `number` of milliseconds,
           * an `ms`-compatible time string like `"1 hour"`, `"30 mins"`, or
           * `"2.5d"`, or a `Date` object.
           *
           * {@link https://npm.im/ms}
           */
          timeout: number | string | Date;
        } & ExclusiveKeys<{ match?: string; if?: string }, "match", "if">,
      >(
        idOrOptions: StepOptionsOrId,
        opts: TOpts,
      ) => Promise<WaitForEventResult<TOpts>>
    >(
      (
        { id, name },

        /**
         * Options to control the event we're waiting for.
         */
        opts,
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

        // Extract event name from string or EventType object
        const eventName =
          typeof opts.event === "string" ? opts.event : opts.event.name;

        return {
          id,
          mode: StepMode.Async,
          op: StepOpCode.WaitForEvent,
          name: eventName,
          opts: matchOpts,
          displayName: name ?? id,
          userland: { id },
        };
      },
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
          options: AiInferOpts<TAdapter>,
        ) => Promise<AiAdapter.Output<TAdapter>>
      >(({ id, name }, options) => {
        // eslint-disable-next-line
        const { model, body, ...rest } = options;

        const modelCopy = { ...model };

        // Allow the model to mutate options and body for this call
        options.model.onCall?.(modelCopy, options.body);

        return {
          id,
          mode: StepMode.Async,
          op: StepOpCode.AiGateway,
          displayName: name ?? id,
          opts: {
            type: "step.ai.infer",
            url: modelCopy.url,
            headers: modelCopy.headers,
            auth_key: modelCopy.authKey,
            format: modelCopy.format,
            // eslint-disable-next-line
            body,
            // eslint-disable-next-line
            ...rest,
          },
          userland: { id },
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
        time: number | string | Temporal.DurationLike,
      ) => Promise<void>
    >(({ id, name }, time) => {
      /**
       * The presence of this operation in the returned stack indicates that the
       * sleep is over and we should continue execution.
       */
      const msTimeStr: string = timeStr(
        Temporal.isTemporalDuration(time)
          ? time.total({ unit: "milliseconds" })
          : (time as number | string),
      );

      return {
        id,
        mode: StepMode.Async,
        op: StepOpCode.Sleep,
        name: msTimeStr,
        displayName: name ?? id,
        userland: { id },
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
        time: Date | string | Temporal.InstantLike | Temporal.ZonedDateTimeLike,
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
          mode: StepMode.Async,
          op: StepOpCode.Sleep,
          name: iso,
          displayName: name ?? id,
          userland: { id },
        };
      } catch (err) {
        /**
         * If we're here, it's because the date is invalid. We'll throw a custom
         * error here to standardise this response.
         */
        client.internalLogger.warn(
          { err },
          "Invalid `Date`, date string, `Temporal.Instant`, or `Temporal.ZonedDateTime` passed to sleepUntil",
        );

        throw new Error(
          `Invalid \`Date\`, date string, \`Temporal.Instant\`, or \`Temporal.ZonedDateTime\` passed to sleepUntil: ${
            time
          }`,
        );
      }
    }),

    /**
     * Invoke a passed Inngest `function` with the given `data`. Returns the
     * result of the returned value of the function or `null` if the function
     * does not return a value.
     */
    invoke: createTool<
      <TFunction extends InvokeTargetFunctionDefinition>(
        idOrOptions: StepOptionsOrId,
        opts: InvocationOpts<TFunction>,
      ) => InvocationResult<
        ApplyAllMiddlewareTransforms<
          MergedMiddleware<TClient, TFnMiddleware>,
          GetFunctionOutputRaw<TFunction>,
          "functionOutputTransform"
        >
      >
    >(({ id, name }, invokeOpts) => {
      // Create a discriminated union to operate on based on the input types
      // available for this tool.
      const optsSchema = invokePayloadSchema.extend({
        timeout: z.union([z.number(), z.string(), z.date()]).optional(),
      });

      const parsedFnOpts = optsSchema
        .extend({
          _type: z.literal("fnInstance").optional().default("fnInstance"),
          function: z.instanceof(InngestFunction),
        })
        .or(
          optsSchema.extend({
            _type: z.literal("refInstance").optional().default("refInstance"),
            function: z.instanceof(InngestFunctionReference),
          }),
        )
        .safeParse(invokeOpts);

      if (!parsedFnOpts.success) {
        throw new Error(
          `Invalid invocation options passed to invoke; must include a function instance or referenceFunction().`,
        );
      }

      const { _type, function: fn, data, v, timeout } = parsedFnOpts.data;
      const payload = { data, v } satisfies MinimalEventPayload;
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

        case "refInstance":
          opts.function_id = [fn.opts.appId || client.id, fn.opts.functionId]
            .filter(Boolean)
            .join("-");
          break;
      }

      return {
        id,
        mode: StepMode.Async,
        op: StepOpCode.InvokeFunction,
        displayName: name ?? id,
        opts,
        userland: { id },
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

  // NOTE: This should be moved into the above object definition under the key
  // "metadata" when metadata is made non-experimental.
  (tools as unknown as ExperimentalStepTools)[metadataSymbol] = (
    memoizationId: string,
  ): MetadataStepTool => createStepMetadataWrapper(memoizationId);

  // Add an uptyped gateway
  (tools as unknown as InternalStepTools)[gatewaySymbol] = createTool(
    ({ id, name }, input, init) => {
      const url = input instanceof Request ? input.url : input.toString();

      const headers: Record<string, string> = {};
      if (input instanceof Request) {
        input.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((value, key) => {
          headers[key] = value;
        });
      }

      return {
        id,
        mode: StepMode.Async,
        op: StepOpCode.Gateway,
        displayName: name ?? id,
        opts: {
          url,
          method: init?.method ?? "GET",
          headers,
          body: init?.body,
        },
        userland: { id },
      };
    },
  );

  return tools;
};

/**
 * A generic set of step tools, without typing information about the client used
 * to create them.
 */
export type GenericStepTools = GetStepTools<Inngest.Any>;

export const gatewaySymbol = Symbol.for("inngest.step.gateway");

export type InternalStepTools = GetStepTools<Inngest.Any> & {
  [gatewaySymbol]: (
    idOrOptions: StepOptionsOrId,
    ...args: Parameters<typeof fetch>
  ) => Promise<{
    status_code: number;
    headers: Record<string, string>;
    body: string;
  }>;
};

export type ExperimentalStepTools = GetStepTools<Inngest.Any> & {
  [metadataSymbol]: (memoizationId: string) => MetadataStepTool;
};

/**
 * A generic set of step tools that can be used without typing information about
 * the client used to create them.
 *
 * These tools use AsyncLocalStorage to track the context in which they are
 * used, and will throw an error if used outside of an Inngest context.
 *
 * The intention of these high-level tools is to allow usage of Inngest step
 * tools within API endpoints, though they can still be used within regular
 * Inngest functions as well.
 */
export const step: GenericStepTools = {
  // TODO Support `step.fetch` (this is already kinda half way deferred)
  fetch: null as unknown as GenericStepTools["fetch"],
  ai: {
    infer: (...args) =>
      getDeferredStepTooling().then((tools) => tools.ai.infer(...args)),
    wrap: (...args) =>
      getDeferredStepTooling().then((tools) => tools.ai.wrap(...args)),
    models: {
      ...models,
    },
  },
  invoke: (...args) =>
    getDeferredStepTooling().then((tools) => tools.invoke(...args)),
  run: (...args) =>
    getDeferredStepTooling().then((tools) => tools.run(...args)),
  sendEvent: (...args) =>
    getDeferredStepTooling().then((tools) => tools.sendEvent(...args)),
  sendSignal: (...args) =>
    getDeferredStepTooling().then((tools) => tools.sendSignal(...args)),
  sleep: (...args) =>
    getDeferredStepTooling().then((tools) => tools.sleep(...args)),
  sleepUntil: (...args) =>
    getDeferredStepTooling().then((tools) => tools.sleepUntil(...args)),
  waitForEvent: (...args) =>
    getDeferredStepTooling().then((tools) => tools.waitForEvent(...args)),
  waitForSignal: (...args) =>
    getDeferredStepTooling().then((tools) => tools.waitForSignal(...args)),
  realtime: {
    publish: (...args) =>
      getDeferredStepTooling().then((tools) => tools.realtime.publish(...args)),
  },
};

/**
 * An internal function used to retrieve or create step tooling for the current
 * execution context.
 *
 * Note that this requires an existing context to create the step tooling;
 * something must declare the Inngest execution context before this can be used.
 */
const getDeferredStepTooling = async (): Promise<GenericStepTools> => {
  const ctx = await getAsyncCtx();
  if (!ctx) {
    throw new Error(
      "`step` tools can only be used within Inngest function executions; no context was found",
    );
  }

  if (!ctx.app) {
    throw new Error(
      "`step` tools can only be used within Inngest function executions; no Inngest client was found in the execution context",
    );
  }

  if (!ctx.execution) {
    throw new Error(
      "`step` tools can only be used within Inngest function executions; no execution context was found",
    );
  }

  // If we're here, we're in the context of a function execution already and
  // we can return the existing step tooling.
  return ctx.execution.ctx.step;
};

/**
 * The event payload portion of the options for `step.invoke()`. This does not
 * include non-payload options like `timeout` or the function to invoke.
 */
export const invokePayloadSchema = z.object({
  data: z.record(z.any()).optional(),
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
 * Computes the return type for `waitForEvent` based on the options provided.
 *
 * Handles three cases:
 * 1. `event: EventType<TName, TSchema>` - extracts name and data from EventType
 * 2. `event: string` with `schema` - uses string as name and schema for data
 * 3. `event: string` without schema - uses string as name with untyped data
 */
type WaitForEventResult<TOpts> =
  // Case 1: event is an EventType with a schema
  TOpts extends {
    event: EventType<
      infer TName extends string,
      StandardSchemaV1<infer TData extends Record<string, unknown>>
    >;
  }
    ? { name: TName; data: TData; id: string; ts: number; v?: string } | null
    : // Case 2: event is an EventType without a schema
      TOpts extends {
          event: EventType<infer TName extends string, undefined>;
        }
      ? {
          name: TName;
          // biome-ignore lint/suspicious/noExplicitAny: fallback for untyped events
          data: Record<string, any>;
          id: string;
          ts: number;
          v?: string;
        } | null
      : // Case 3: event is a string with schema (spread EventType)
        TOpts extends {
            event: infer TName extends string;
            schema: StandardSchemaV1<
              infer TData extends Record<string, unknown>
            >;
          }
        ? {
            name: TName;
            data: TData;
            id: string;
            ts: number;
            v?: string;
          } | null
        : // Case 4: event is just a string
          TOpts extends { event: infer TName extends string }
          ? {
              name: TName;
              // biome-ignore lint/suspicious/noExplicitAny: fallback for untyped events
              data: Record<string, any>;
              id: string;
              ts: number;
              v?: string;
            } | null
          : EventPayload | null;

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
