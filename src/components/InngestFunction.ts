import { internalEvents, queryKeys } from "../helpers/consts";
import { deserializeError, serializeError } from "../helpers/errors";
import { resolveAfterPending, resolveNextTick } from "../helpers/promises";
import { type ServerTiming } from "../helpers/ServerTiming";
import { slugify, timeStr } from "../helpers/strings";
import {
  StepOpCode,
  type Context,
  type EventNameFromTrigger,
  type EventPayload,
  type FailureEventArgs,
  type FailureEventPayload,
  type FunctionConfig,
  type FunctionOptions,
  type FunctionTrigger,
  type Handler,
  type IncomingOp,
  type OpStack,
  type OutgoingOp,
} from "../types";
import { type Inngest } from "./Inngest";
import { createStepTools, type TickOp } from "./InngestStepTools";

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
  Events extends Record<string, EventPayload> = Record<string, EventPayload>,
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

  readonly #opts: Opts;
  readonly #trigger: Trigger;
  readonly #fn: Handler<Events, keyof Events & string>;
  readonly #onFailureFn?: Handler<Events, keyof Events & string>;
  readonly #client: Inngest<Events>;

  /**
   * A stateless Inngest function, wrapping up function configuration and any
   * in-memory steps to run when triggered.
   *
   * This function can be "registered" to create a handler that Inngest can
   * trigger remotely.
   */
  constructor(
    client: Inngest<Events>,

    /**
     * Options
     */
    opts: Opts,
    trigger: Trigger,
    fn: Handler<Events, keyof Events & string>
  ) {
    this.#client = client;
    this.#opts = opts;
    this.#trigger = trigger;
    this.#fn = fn;
    this.#onFailureFn = this.#opts.onFailure;
  }

  /**
   * The generated or given ID for this function.
   */
  public id(prefix?: string) {
    return this.#opts.id || this.#generateId(prefix);
  }

  /**
   * The name of this function as it will appear in the Inngest Cloud UI.
   */
  public get name() {
    return this.#opts.name;
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

    const { retries: attempts, cancelOn, fns: _, ...opts } = this.#opts;

    /**
     * Convert retries into the format required when defining function
     * configuration.
     */
    const retries = typeof attempts === "undefined" ? undefined : { attempts };

    const fn: FunctionConfig = {
      ...opts,
      id: fnId,
      name: this.name,
      triggers: [this.#trigger as FunctionTrigger],
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
    const memoizingStop = timer.start("memoizing");

    /**
     * Create some values to be mutated and passed to the step tools. Once the
     * user's function has run, we can check the mutated state of these to see
     * if an op has been submitted or not.
     */
    const [tools, state] = createStepTools(this.#client);

    /**
     * Create args to pass in to our function. We blindly pass in the data and
     * add tools.
     */
    const fnArg = {
      ...(data as { event: EventPayload }),
      tools,
      step: tools,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as Partial<Context<any, any, any>>;

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
        throw new Error(
          `Function "${this.name}" received a failure event to handle, but no failure handler was defined.`
        );
      }

      userFnToRun = this.#onFailureFn;

      (fnArg as FailureEventArgs).error = deserializeError(
        (fnArg.event as FailureEventPayload).data.error
      );
    }

    /**
     * If the user has passed functions they wish to use in their step, add them
     * here.
     *
     * We simply place a thin `tools.run()` wrapper around the function and
     * nothing else.
     */
    if (this.#opts.fns) {
      fnArg.fns = Object.entries(this.#opts.fns).reduce((acc, [key, fn]) => {
        if (typeof fn !== "function") {
          return acc;
        }

        return {
          ...acc,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
          [key]: (...args: unknown[]) => tools.run(key, () => fn(...args)),
        };
      }, {});
    }

    // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
    const userFnPromise = new Promise(async (resolve, reject) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolve(await userFnToRun(fnArg as Context<any, any, any>));
      } catch (err) {
        reject(err);
      }
    });

    let pos = -1;

    do {
      if (pos >= 0) {
        state.tickOps = {};
        const incomingOp = opStack[pos] as IncomingOp;
        state.currentOp = state.allFoundOps[incomingOp.id];

        if (!state.currentOp) {
          throw new Error(
            `Bad stack; could not find local op "${incomingOp.id}" at position ${pos}`
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
        throw new Error(
          `Bad stack; executor requesting to run unknown step "${runStep}"`
        );
      }

      const runningStepStop = timer.start("running-step");

      const result = await new Promise((resolve) => {
        return resolve(userFnToRun());
      })
        .then((data) => {
          return {
            data: typeof data === "undefined" ? null : data,
          };
        })
        .catch((err: Error) => {
          /**
           * If the user-defined code throws an error, we should return this
           * to Inngest as the response for this step. The function didn't
           * fail, only this step, so Inngest can decide what we do next.
           *
           * Make sure to log this so the user sees what has happened in the
           * console.
           */
          console.error(err);

          try {
            return {
              error: serializeError(err),
            };
          } catch (serializationErr) {
            console.warn(
              "Could not serialize error to return to Inngest; stringifying instead",
              serializationErr
            );

            return {
              error: err,
            };
          }
        })
        .finally(() => {
          runningStepStop();
        });

      return [
        "run",
        { ...tickOpToOutgoing(userFnOp), ...result, op: StepOpCode.RunStep },
      ];
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
        /**
         * The function has returned a value, so we should return this to
         * Inngest. Doing this will cause the function to be marked as
         * complete, so we should only do this if we're sure that all
         * registered ops have been resolved.
         */
        const allOpsFulfilled = Object.values(state.allFoundOps).every((op) => {
          return op.fulfilled;
        });

        if (allOpsFulfilled) {
          return ["complete", fnRet.data];
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
         */
        return ["complete", await userFnPromise];
      }
    }

    return ["discovery", discoveredOps];
  }

  /**
   * Generate an ID based on the function's name.
   */
  #generateId(prefix?: string) {
    return slugify([prefix || "", this.#opts.name].join("-"));
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
