import { z } from "zod";
import { type ServerTiming } from "../helpers/ServerTiming";
import { internalEvents, queryKeys } from "../helpers/consts";
import {
  ErrCode,
  OutgoingResultError,
  deserializeError,
  functionStoppedRunningErr,
  serializeError,
} from "../helpers/errors";
import { resolveAfterPending, resolveNextTick } from "../helpers/promises";
import { slugify, timeStr } from "../helpers/strings";
import {
  StepOpCode,
  failureEventErrorSchema,
  type BaseContext,
  type ClientOptions,
  type Context,
  type EventNameFromTrigger,
  type EventPayload,
  type FailureEventArgs,
  type FunctionConfig,
  type FunctionOptions,
  type FunctionTrigger,
  type Handler,
  type IncomingOp,
  type OpStack,
  type OutgoingOp,
} from "../types";
import { type EventsFromOpts, type Inngest } from "./Inngest";
import {
  getHookStack,
  type MiddlewareRegisterReturn,
  type RunHookStack,
} from "./InngestMiddleware";
import { createStepTools, type TickOp } from "./InngestStepTools";
import { NonRetriableError } from "./NonRetriableError";

/**
 * A stateless Inngest function, wrapping up function configuration and any
 * in-memory steps to run when triggered.
 *
 * This function can be "registered" to create a handler that Inngest can
 * trigger remotely.
 *
 * @public
 */
export class InngestFunction<
  TOpts extends ClientOptions = ClientOptions,
  Events extends EventsFromOpts<TOpts> = EventsFromOpts<TOpts>,
  Trigger extends FunctionTrigger<keyof Events & string> = FunctionTrigger<
    keyof Events & string
  >,
  Opts extends FunctionOptions<
    Events,
    EventNameFromTrigger<Events, Trigger>
  > = FunctionOptions<Events, EventNameFromTrigger<Events, Trigger>>
> {
  static stepId = "step";
  static failureSuffix = "-failure";

  public readonly opts: Opts;
  public readonly trigger: Trigger;
  readonly #fn: Handler<TOpts, Events, keyof Events & string>;
  readonly #onFailureFn?: Handler<TOpts, Events, keyof Events & string>;
  readonly #client: Inngest<TOpts>;
  private readonly middleware: Promise<MiddlewareRegisterReturn[]>;

  /**
   * A stateless Inngest function, wrapping up function configuration and any
   * in-memory steps to run when triggered.
   *
   * This function can be "registered" to create a handler that Inngest can
   * trigger remotely.
   */
  constructor(
    client: Inngest<TOpts>,

    /**
     * Options
     */
    opts: Opts,
    trigger: Trigger,
    fn: Handler<TOpts, Events, keyof Events & string>
  ) {
    this.#client = client;
    this.opts = opts;
    this.trigger = trigger;
    this.#fn = fn;
    this.#onFailureFn = this.opts.onFailure;

    this.middleware = this.#client["initializeMiddleware"](
      this.opts.middleware,
      { registerInput: { fn: this }, prefixStack: this.#client["middleware"] }
    );
  }

  /**
   * The generated or given ID for this function.
   */
  public id(prefix?: string) {
    return this.opts.id || this.#generateId(prefix);
  }

  /**
   * The name of this function as it will appear in the Inngest Cloud UI.
   */
  public get name() {
    return this.opts.name;
  }

  /**
   * Retrieve the Inngest config for this function.
   */
  private getConfig(
    /**
     * Must be provided a URL that will be used to access the function and step.
     * This function can't be expected to know how it will be accessed, so
     * relies on an outside method providing context.
     */
    baseUrl: URL,
    appPrefix?: string
  ): FunctionConfig[] {
    const fnId = this.id(appPrefix);
    const stepUrl = new URL(baseUrl.href);
    stepUrl.searchParams.set(queryKeys.FnId, fnId);
    stepUrl.searchParams.set(queryKeys.StepId, InngestFunction.stepId);

    const { retries: attempts, cancelOn, fns: _, ...opts } = this.opts;

    /**
     * Convert retries into the format required when defining function
     * configuration.
     */
    const retries = typeof attempts === "undefined" ? undefined : { attempts };

    const fn: FunctionConfig = {
      ...opts,
      id: fnId,
      name: this.name,
      triggers: [this.trigger as FunctionTrigger],
      steps: {
        [InngestFunction.stepId]: {
          id: InngestFunction.stepId,
          name: InngestFunction.stepId,
          runtime: {
            type: "http",
            url: stepUrl.href,
          },
          retries,
        },
      },
    };

    if (cancelOn) {
      fn.cancel = cancelOn.map(({ event, timeout, if: ifStr, match }) => {
        const ret: NonNullable<FunctionConfig["cancel"]>[number] = {
          event,
        };

        if (timeout) {
          ret.timeout = timeStr(timeout);
        }

        if (match) {
          ret.if = `event.${match} == async.${match}`;
        } else if (ifStr) {
          ret.if = ifStr;
        }

        return ret;
      }, []);
    }

    const config: FunctionConfig[] = [fn];

    if (this.#onFailureFn) {
      const failureOpts = { ...opts };
      const id = `${fn.id}${InngestFunction.failureSuffix}`;
      const name = `${fn.name} (failure)`;

      const failureStepUrl = new URL(stepUrl.href);
      failureStepUrl.searchParams.set(queryKeys.FnId, id);

      config.push({
        ...failureOpts,
        id,
        name,
        triggers: [
          {
            event: internalEvents.FunctionFailed,
            expression: `event.data.function_id == '${fnId}'`,
          },
        ],
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: failureStepUrl.href,
            },
            retries: { attempts: 1 },
          },
        },
      });
    }

    return config;
  }

  /**
   * Run this function, optionally providing an op stack to pass as state.
   *
   * It is a `private` method to prevent users from being exposed to it
   * directly, but ensuring it is available to the generated handler.
   *
   * For a single-step function that doesn't use any step tooling, this will
   * await the result of the function given to this instance of
   * `InngestFunction` and return the data and a boolean indicating that the
   * function is complete and should not be called again.
   *
   * For a multi-step function, also try to await the result of the function
   * given to this instance of `InngestFunction`, though will check whether an
   * op has been submitted for use (or a Promise is pending, such as a step
   * running) after the function has completed.
   */
  private async runFn(
    /**
     * The data to pass to the function, probably straight from Inngest.
     */
    data: unknown,

    /**
     * The op stack to pass to the function as state, likely stored in
     * `ctx._state` in the Inngest payload.
     *
     * This must be provided in order to always be cognizant of step function
     * state and to allow for multi-step functions.
     */
    opStack: OpStack,

    /**
     * The step ID that Inngest wants to run and receive data from. If this is
     * defined, the step's user code will be run after filling the op stack. If
     * this is `null`, the function will be run and next operations will be
     * returned instead.
     */
    requestedRunStep: string | null,

    timer: ServerTiming,

    /**
     * TODO Ugly boolean option; wrap this.
     */
    isFailureHandler: boolean
  ): Promise<
    | [type: "complete", data: unknown]
    | [type: "discovery", ops: OutgoingOp[]]
    | [type: "run", op: OutgoingOp]
  > {
    const ctx = data as Pick<
      Readonly<
        BaseContext<
          ClientOptions,
          string,
          Record<string, (...args: unknown[]) => unknown>
        >
      >,
      "event" | "events" | "runId"
    >;

    const hookStack = await getHookStack(
      this.middleware,
      "onFunctionRun",
      { ctx, fn: this, steps: opStack },
      {
        transformInput: (prev, output) => {
          return {
            ctx: { ...prev.ctx, ...output?.ctx },
            fn: this,
            steps: prev.steps.map((step, i) => ({
              ...step,
              ...output?.steps?.[i],
            })),
          };
        },
        transformOutput: (prev, output) => {
          return {
            result: { ...prev.result, ...output?.result },
            step: prev.step,
          };
        },
      }
    );

    const createFinalError = async (
      err: unknown,
      step?: OutgoingOp
    ): Promise<OutgoingResultError> => {
      await hookStack.afterExecution?.();

      const result: Pick<OutgoingOp, "error" | "data"> = {
        error: err,
      };

      try {
        result.data = serializeError(err);
      } catch (serializationErr) {
        console.warn(
          "Could not serialize error to return to Inngest; stringifying instead",
          serializationErr
        );

        result.data = err;
      }

      const hookOutput = await applyHookToOutput(hookStack.transformOutput, {
        result,
        step,
      });

      return new OutgoingResultError(hookOutput);
    };

    const state = createExecutionState();

    const memoizingStop = timer.start("memoizing");

    /**
     * Create some values to be mutated and passed to the step tools. Once the
     * user's function has run, we can check the mutated state of these to see
     * if an op has been submitted or not.
     */
    const step = createStepTools(this.#client, state);

    try {
      /**
       * Create args to pass in to our function. We blindly pass in the data and
       * add tools.
       */
      let fnArg = {
        ...(data as { event: EventPayload }),
        step,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as Context<TOpts, Events, any, any>;

      let userFnToRun = this.#fn;

      /**
       * If the incoming event is an Inngest function failure event, we also want
       * to pass some extra data to the function to act as shortcuts to the event
       * payload.
       */
      if (isFailureHandler) {
        /**
         * The user could have created a function that intentionally listens for
         * these events. In this case, we may want to use the original handler.
         *
         * We only use the onFailure handler if
         */
        if (!this.#onFailureFn) {
          // TODO PrettyError
          throw new Error(
            `Function "${this.name}" received a failure event to handle, but no failure handler was defined.`
          );
        }

        userFnToRun = this.#onFailureFn;

        const eventData = z
          .object({ error: failureEventErrorSchema })
          .parse(fnArg.event?.data);

        (fnArg as Partial<Pick<FailureEventArgs, "error">>) = {
          ...fnArg,
          error: deserializeError(eventData.error),
        };
      }

      /**
       * If the user has passed functions they wish to use in their step, add them
       * here.
       *
       * We simply place a thin `tools.run()` wrapper around the function and
       * nothing else.
       */
      if (this.opts.fns) {
        fnArg.fns = Object.entries(this.opts.fns).reduce((acc, [key, fn]) => {
          if (typeof fn !== "function") {
            return acc;
          }

          return {
            ...acc,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
            [key]: (...args: unknown[]) => step.run(key, () => fn(...args)),
          };
        }, {});
      }

      const inputMutations = await hookStack.transformInput?.({
        ctx: { ...fnArg } as unknown as Parameters<
          NonNullable<(typeof hookStack)["transformInput"]>
        >[0]["ctx"],
        steps: opStack,
        fn: this,
      });

      if (inputMutations?.ctx) {
        fnArg = inputMutations?.ctx as unknown as Context<
          TOpts,
          Events,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          any
        >;
      }

      if (inputMutations?.steps) {
        opStack = inputMutations?.steps as OpStack;
      }

      await hookStack.beforeMemoization?.();

      if (opStack.length === 0 && !requestedRunStep) {
        await hookStack.afterMemoization?.();
        await hookStack.beforeExecution?.();
      }

      // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
      const userFnPromise = new Promise(async (resolve, reject) => {
        try {
          resolve(await userFnToRun(fnArg));
        } catch (err) {
          // logger.error(err);
          reject(err);
        }
      });

      let pos = -1;

      do {
        if (pos >= 0) {
          if (!requestedRunStep && pos == opStack.length - 1) {
            await hookStack.afterMemoization?.();
            await hookStack.beforeExecution?.();
          }

          state.tickOps = {};
          const incomingOp = opStack[pos] as IncomingOp;
          state.currentOp = state.allFoundOps[incomingOp.id];

          if (!state.currentOp) {
            /**
             * We're trying to resume the function, but we can't find where to go.
             *
             * This means that either the function has changed or there are async
             * actions in-between steps that we haven't noticed in previous
             * executions.
             *
             * Whichever the case, this is bad and we can't continue in this
             * undefined state.
             */
            throw new NonRetriableError(
              functionStoppedRunningErr(
                ErrCode.ASYNC_DETECTED_DURING_MEMOIZATION
              )
            );
          }

          state.currentOp.fulfilled = true;

          if (typeof incomingOp.data !== "undefined") {
            state.currentOp.resolve(incomingOp.data);
          } else {
            state.currentOp.reject(incomingOp.error);
          }
        }

        await timer.wrap("memoizing-ticks", resolveAfterPending);

        state.reset();
        pos++;
      } while (pos < opStack.length);

      memoizingStop();
      await hookStack.afterMemoization?.();

      const discoveredOps = Object.values(state.tickOps).map<OutgoingOp>(
        tickOpToOutgoing
      );

      /**
       * We make an optimization here by immediately invoking an op if it's the
       * only one we've discovered. The alternative is to plan the step and then
       * complete it, so we skip at least one entire execution with this.
       */
      const runStep = requestedRunStep || getEarlyExecRunStep(discoveredOps);

      if (runStep) {
        const userFnOp = state.allFoundOps[runStep];
        const userFnToRun = userFnOp?.fn;

        if (!userFnToRun) {
          // TODO PrettyError
          throw new Error(
            `Bad stack; executor requesting to run unknown step "${runStep}"`
          );
        }

        const outgoingUserFnOp = {
          ...tickOpToOutgoing(userFnOp),
          op: StepOpCode.RunStep,
        };

        await hookStack.beforeExecution?.();
        const runningStepStop = timer.start("running-step");
        state.executingStep = true;

        const result = await new Promise((resolve) => {
          return resolve(userFnToRun());
        })
          .finally(() => {
            state.executingStep = false;
            runningStepStop();
          })
          .catch(async (err: Error) => {
            return await createFinalError(err, outgoingUserFnOp);
          })
          .then(async (data) => {
            await hookStack.afterExecution?.();

            return await applyHookToOutput(hookStack.transformOutput, {
              result: { data: typeof data === "undefined" ? null : data },
              step: outgoingUserFnOp,
            });
          });

        return ["run", { ...outgoingUserFnOp, ...result }];
      }

      /**
       * Now we're here, we've memoised any function state and we know that this
       * request was a discovery call to find out next steps.
       *
       * We've already given the user's function a lot of chance to register any
       * more ops, so we can assume that this list of discovered ops is final.
       *
       * With that in mind, if this list is empty AND we haven't previously used
       * any step tools, we can assume that the user's function is not one that'll
       * be using step tooling, so we'll just wait for it to complete and return
       * the result.
       *
       * An empty list while also using step tooling is a valid state when the end
       * of a chain of promises is reached, so we MUST also check if step tooling
       * has previously been used.
       */
      if (!discoveredOps.length) {
        const fnRet = await Promise.race([
          userFnPromise.then((data) => ({ type: "complete", data } as const)),
          resolveNextTick().then(() => ({ type: "incomplete" } as const)),
        ]);

        if (fnRet.type === "complete") {
          await hookStack.afterExecution?.();

          /**
           * The function has returned a value, so we should return this to
           * Inngest. Doing this will cause the function to be marked as
           * complete, so we should only do this if we're sure that all
           * registered ops have been resolved.
           */
          const allOpsFulfilled = Object.values(state.allFoundOps).every(
            (op) => {
              return op.fulfilled;
            }
          );

          if (allOpsFulfilled) {
            const result = await applyHookToOutput(hookStack.transformOutput, {
              result: { data: fnRet.data },
            });

            return ["complete", result.data];
          }

          /**
           * If we're here, it means that the user's function has returned a
           * value but not all ops have been resolved. This might be intentional
           * if they are purposefully pushing work to the background, but also
           * might be unintentional and a bug in the user's code where they
           * expected an order to be maintained.
           *
           * To be safe, we'll show a warning here to tell users that this might
           * be unintentional, but otherwise carry on as normal.
           */
          // TODO PrettyError
          console.warn(
            `Warning: Your "${this.name}" function has returned a value, but not all ops have been resolved, i.e. you have used step tooling without \`await\`. This may be intentional, but if you expect your ops to be resolved in order, you should \`await\` them. If you are knowingly leaving ops unresolved using \`.catch()\` or \`void\`, you can ignore this warning.`
          );
        } else if (!state.hasUsedTools) {
          /**
           * If we're here, it means that the user's function has not returned
           * a value, but also has not used step tooling. This is a valid
           * state, indicating that the function is a single-action async
           * function.
           *
           * We should wait for the result and return it.
           *
           * A caveat here is that the user could use step tooling later on,
           * resulting in a mix of step and non-step logic. This is not something
           * we want to support without an opt-in from the user, so we should
           * throw if this is the case.
           */
          state.nonStepFnDetected = true;

          const data = await userFnPromise;
          await hookStack.afterExecution?.();

          const { data: result } = await applyHookToOutput(
            hookStack.transformOutput,
            {
              result: { data },
            }
          );

          return ["complete", result];
        } else {
          /**
           * If we're here, the user's function has not returned a value, has not
           * reported any new ops, but has also previously used step tools and
           * successfully memoized state.
           *
           * This indicates that the user has mixed step and non-step logic, which
           * is not something we want to support without an opt-in from the user.
           *
           * We should throw here to let the user know that this is not supported.
           *
           * We need to be careful, though; it's a valid state for a chain of
           * promises to return no further actions, so we should only throw if
           * this state is reached and there are no other pending steps.
           */
          const hasOpsPending = Object.values(state.allFoundOps).some((op) => {
            return op.fulfilled === false;
          });

          if (!hasOpsPending) {
            throw new NonRetriableError(
              functionStoppedRunningErr(
                ErrCode.ASYNC_DETECTED_AFTER_MEMOIZATION
              )
            );
          }
        }
      }

      await hookStack.afterExecution?.();

      return ["discovery", discoveredOps];
    } catch (err) {
      throw await createFinalError(err);
    } finally {
      await hookStack.beforeResponse?.();
    }
  }

  /**
   * Generate an ID based on the function's name.
   */
  #generateId(prefix?: string) {
    return slugify([prefix || "", this.opts.name].join("-"));
  }
}

const tickOpToOutgoing = (op: TickOp): OutgoingOp => {
  return {
    op: op.op,
    id: op.id,
    name: op.name,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    opts: op.opts,
  };
};

/**
 * Given the list of outgoing ops, decide if we can execute an op early and
 * return the ID of the step to run if we can.
 */
const getEarlyExecRunStep = (ops: OutgoingOp[]): string | undefined => {
  if (ops.length !== 1) return;

  const op = ops[0];

  if (
    op &&
    op.op === StepOpCode.StepPlanned &&
    typeof op.opts === "undefined"
  ) {
    return op.id;
  }
};

export interface ExecutionState {
  /**
   * The tree of all found ops in the entire invocation.
   */
  allFoundOps: Record<string, TickOp>;

  /**
   * All synchronous operations found in this particular tick. The array is
   * reset every tick.
   */
  tickOps: Record<string, TickOp>;

  /**
   * A hash of operations found within this tick, with keys being the hashed
   * ops themselves (without a position) and the values being the number of
   * times that op has been found.
   *
   * This is used to provide some mutation resilience to the op stack,
   * allowing us to survive same-tick mutations of code by ensuring per-tick
   * hashes are based on uniqueness rather than order.
   */
  tickOpHashes: Record<string, number>;

  /**
   * Tracks the current operation being processed. This can be used to
   * understand the contextual parent of any recorded operations.
   */
  currentOp: TickOp | undefined;

  /**
   * If we've found a user function to run, we'll store it here so a component
   * higher up can invoke and await it.
   */
  userFnToRun?: (...args: unknown[]) => unknown;

  /**
   * A boolean to represent whether the user's function is using any step
   * tools.
   *
   * If the function survives an entire tick of the event loop and hasn't
   * touched any tools, we assume that it is a single-step async function and
   * should be awaited as usual.
   */
  hasUsedTools: boolean;

  /**
   * A function that should be used to reset the state of the tools after a
   * tick has completed.
   */
  reset: () => void;

  /**
   * If `true`, any use of step tools will, by default, throw an error. We do
   * this when we detect that a function may be mixing step and non-step code.
   *
   * Created step tooling can decide how to manually handle this on a
   * case-by-case basis.
   *
   * In the future, we can provide a way for a user to override this if they
   * wish to and understand the danger of side-effects.
   *
   * Defaults to `false`.
   */
  nonStepFnDetected: boolean;

  /**
   * When true, we are currently executing a user's code for a single step
   * within a step function.
   */
  executingStep: boolean;
}

export const createExecutionState = (): ExecutionState => {
  const state: ExecutionState = {
    allFoundOps: {},
    tickOps: {},
    tickOpHashes: {},
    currentOp: undefined,
    hasUsedTools: false,
    reset: () => {
      state.tickOpHashes = {};
      state.allFoundOps = { ...state.allFoundOps, ...state.tickOps };
    },
    nonStepFnDetected: false,
    executingStep: false,
  };

  return state;
};

const applyHookToOutput = async (
  outputHook: RunHookStack["transformOutput"],
  arg: Parameters<NonNullable<RunHookStack["transformOutput"]>>[0]
): Promise<Pick<OutgoingOp, "data" | "error">> => {
  const hookOutput = await outputHook?.(arg);
  return { ...arg.result, ...hookOutput?.result };
};
