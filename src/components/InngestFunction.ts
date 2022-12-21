import { serializeError } from "serialize-error-cjs";
import { queryKeys } from "../helpers/consts";
import { resolveNextTick } from "../helpers/promises";
import { slugify } from "../helpers/strings";
import {
  EventData,
  EventPayload,
  FunctionConfig,
  FunctionOptions,
  FunctionTrigger,
  HandlerArgs,
  IncomingOp,
  OpStack,
  OutgoingOp,
} from "../types";
import { createStepTools, TickOp } from "./InngestStepTools";

/**
 * A stateless Inngest function, wrapping up function configuration and any
 * in-memory steps to run when triggered.
 *
 * This function can be "registered" to create a handler that Inngest can
 * trigger remotely.
 *
 * @public
 */
export class InngestFunction<Events extends Record<string, EventPayload>> {
  static stepId = "step";

  readonly #opts: FunctionOptions;
  readonly #trigger: FunctionTrigger<keyof Events>;
  readonly #fn: (...args: any[]) => any;

  /**
   * A stateless Inngest function, wrapping up function configuration and any
   * in-memory steps to run when triggered.
   *
   * This function can be "registered" to create a handler that Inngest can
   * trigger remotely.
   */
  constructor(
    /**
     * Options
     */
    opts: FunctionOptions,
    trigger: FunctionTrigger<keyof Events>,
    fn: (...args: any[]) => any
  ) {
    this.#opts = opts;
    this.#trigger = trigger;
    this.#fn = fn;
  }

  /**
   * The generated or given ID for this function.
   */
  public id(prefix?: string) {
    if (!this.#opts.id) {
      this.#opts.id = this.#generateId(prefix);
    }

    return this.#opts.id;
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
  ): FunctionConfig {
    const fnId = this.id(appPrefix);

    const stepUrl = new URL(baseUrl.href);
    stepUrl.searchParams.set(queryKeys.FnId, fnId);
    stepUrl.searchParams.set(queryKeys.StepId, InngestFunction.stepId);

    return {
      ...this.#opts,
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
        },
      },
    };
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
   *
   * In both cases, an unknown error (i.e. anything except a
   * `StepFlowInterrupt` error) will bubble up to the caller, meaning the caller
   * must handle what to do with the error.
   */
  private async runFn(
    /**
     * The data to pass to the function, probably straight from Inngest.
     */
    data: any,

    /**
     * The op stack to pass to the function as state, likely stored in
     * `ctx._state` in the Inngest payload.
     *
     * This must be provided in order to always be cognizant of step function
     * state and to allow for multi-step functions.
     */
    opStack: OpStack
    // ): Promise<[isOp: true, op: HashedOp[]] | [isOp: false, data: unknown]> {
  ): Promise<
    | [type: "single", data: unknown]
    | [type: "multi-discovery", ops: OutgoingOp[]]
    | [type: "multi-run", data: { data: any } | { error: any }]
  > {
    /**
     * Create some values to be mutated and passed to the step tools. Once the
     * user's function has run, we can check the mutated state of these to see
     * if an op has been submitted or not.
     */
    const [tools, state] = createStepTools();

    /**
     * Create args to pass in to our function. We blindly pass in the data and
     * add tools.
     */
    const fnArg = {
      ...(data as EventData<string>),
      tools,
    } as Partial<HandlerArgs<any, any, any>>;

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
          [key]: (...args: any[]) => tools.run(key, () => fn(...args)),
        };
      }, {});
    }

    // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
    const userFnPromise = new Promise(async (resolve, reject) => {
      try {
        resolve(await this.#fn(fnArg));
      } catch (err) {
        reject(err);
      }
    });

    /**
     * If we haven't sychronously touched any tools yet, we can assume we're not
     * looking at a step function.
     *
     * Await the user function as normal.
     */
    if (!state.hasUsedTools) {
      return ["single", await userFnPromise];
    }

    do {
      console.log("do hit");
      if (state.pos >= 0) {
        console.log("state.pos hit:", state.pos);
        const incomingOp = opStack[state.pos] as IncomingOp;
        console.log("incomingOp:", incomingOp);
        let targetOps = state.allFoundOps;
        console.log("allFoundOps:", state.allFoundOps);
        let currentOp: TickOp | undefined;

        for (let i = 0; i < incomingOp.opPosition.length; i++) {
          currentOp = targetOps[incomingOp.opPosition[i] as number] as TickOp;
          const isLastAccess = incomingOp.opPosition.length - 1 === i;

          if (!isLastAccess) {
            targetOps = currentOp.tickOps;
            continue;
          }

          if (incomingOp.run) {
            if (!currentOp.fn) {
              throw new Error("Bad stack; no fn to execute; re-execute pls");
            }

            state.userFnToRun = currentOp.fn;
            break;
          }

          if (typeof incomingOp.data !== "undefined") {
            currentOp.resolve(incomingOp.data);
          } else {
            currentOp.reject(incomingOp.error);
          }
        }

        if (state.userFnToRun) {
          break;
        }

        if (!currentOp) {
          throw new Error("Bad stack; fn might have changed; re-execute");
        }

        state.tickOps = currentOp.tickOps;
      }

      await resolveNextTick();
      state.pos++;
    } while (state.pos < opStack.length);

    const { userFnToRun } = state;

    if (userFnToRun) {
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
           */
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
        });

      return ["multi-run", result];
    }

    const discoveredOps = state.tickOps.map<OutgoingOp>((op, index) => {
      return {
        op: op.op,
        ...(op.fn ? { run: true } : {}),
        id: op.id,
        name: op.name,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        opts: op.opts,
        opPosition: [...(opStack[opStack.length - 1]?.opPosition ?? []), index],
      };
    });

    return ["multi-discovery", discoveredOps];

    // /**
    //  * Attempt to run the function. If this is a step function, we expect to
    //  * catch `StepFlowInterrupt` errors and ignore them, as they are used to
    //  * interrupt function execution safely.
    //  */
    // try {
    //   /**
    //    * Ensure the function only runs for a single tick, to ensure no actual
    //    * async actions are taken and we only get the next queued operations.
    //    */
    //   const tickPromise = new Promise((_, reject) => {
    //     setTimeout(() => reject(new StepFlowExpired()));
    //   });

    //   // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
    //   userFnPromise = new Promise(async (resolve, reject) => {
    //     try {
    //       resolve(await this.#fn(fnArg));
    //     } catch (err) {
    //       reject(err);
    //     }
    //   });

    //   await Promise.race([userFnPromise, tickPromise]);
    // } catch (err) {
    //   if (err instanceof StepFlowExpired) {
    //     /**
    //      * If this has thrown, it means the function has had a single tick of
    //      * the event loop to decide what it wants to do next.
    //      *
    //      * If we've used tools but don't have an op, we can assume the function
    //      * is waiting on other operations to complete, so we can return a no-op
    //      * to Inngest for now.
    //      */
    //     if (state.hasUsedTools && !state.nextOps.length) {
    //       return [true, []];
    //     }
    //   } else {
    //     /**
    //      * If the error is not a StepFlowInterrupt or a StepFlowExpires, then it
    //      * is an error that we should probably bubble up.
    //      *
    //      * An exception is if the error has been somehow caused after
    //      * successfully submitting a new op. This might happen if a user
    //      * attempts to catch step errors with a try/catch block. In that case,
    //      * we should warn of this but continue on.
    //      */
    //     if (!state.nextOps.length) {
    //       throw err;
    //     }

    //     /**
    //      * If we're here, then this unknown error was caused after successfully
    //      * submitting an op.
    //      *
    //      * In this case, we warn the user that trying to catch these is not a
    //      * good idea and continue on; the step tool itself will attempt to throw
    //      * again to stop execution.
    //      */
    //     console.warn(
    //       "An error occurred after submitting a new op. Continuing on.",
    //       err
    //     );
    //   }
    // }

    // /**
    //  * This could be a step function that has triggered an asynchronous step
    //  * right at this moment.
    //  *
    //  * If this is the case, the above function will have now resolved and the
    //  * async step function might still be running.
    //  *
    //  * Let's check for this occurence by checking the toolset we created to see
    //  * if there is a pending op. If there is, wait for that, otherwise continue
    //  * straight to the end.
    //  */
    // if (state.nextOps.length) {
    //   return [true, await Promise.all(state.nextOps)];
    // }

    // return [false, await userFnPromise];
  }

  /**
   * Generate an ID based on the function's name.
   */
  #generateId(prefix?: string) {
    return slugify([prefix || "", this.#opts.name].join("-"));
  }
}
