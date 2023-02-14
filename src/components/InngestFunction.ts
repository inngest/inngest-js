import { queryKeys } from "../helpers/consts";
import { serializeError } from "../helpers/errors";
import { resolveAfterPending, resolveNextTick } from "../helpers/promises";
import { ServerTiming } from "../helpers/ServerTiming";
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
  StepOpCode,
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

    const { retries: attempts, ...opts } = this.#opts;

    /**
     * Convert retries into the format required when defining function
     * configuration.
     */
    const retries = typeof attempts === "undefined" ? undefined : { attempts };

    return {
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
    data: any,

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
    runStep: string | null,

    timer: ServerTiming
  ): Promise<
    | [type: "single", data: unknown]
    | [type: "multi-discovery", ops: OutgoingOp[]]
    | [type: "multi-run", op: OutgoingOp]
    | [type: "multi-complete", data: unknown]
  > {
    const memoizingStop = timer.start("memoizing");

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
      step: tools,
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
      memoizingStop();
      return ["single", await userFnPromise];
    }

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
        "multi-run",
        { ...tickOpToOutgoing(userFnOp), ...result, op: StepOpCode.RunStep },
      ];
    }

    const discoveredOps = Object.values(state.tickOps).map<OutgoingOp>(
      tickOpToOutgoing
    );

    /**
     * If we haven't discovered any ops, it's possible that the user's function
     * has completed. In this case, we should return any returned data to
     * Inngest as the response.
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
         * complete, so we should only do this if we're sure that all registered
         * ops have been resolved.
         */
        const allOpsFulfilled = Object.values(state.allFoundOps).every((op) => {
          return op.fulfilled;
        });

        if (allOpsFulfilled) {
          return ["multi-complete", fnRet.data];
        }

        /**
         * If we're here, it means that the user's function has returned a value
         * but not all ops have been resolved. This might be intentional if they
         * are purposefully pushing work to the background, but also might be
         * unintentional and a bug in the user's code where they expected an
         * order to be maintained.
         *
         * To be safe, we'll show a warning here to tell users that this might
         * be unintentional, but otherwise carry on as normal.
         */
        console.warn(
          `Warning: Your "${this.name}" function has returned a value, but not all ops have been resolved, i.e. you have used step tooling without \`await\`. This may be intentional, but if you expect your ops to be resolved in order, you should \`await\` them. If you are knowingly leaving ops unresolved using \`.catch()\` or \`void\`, you can ignore this warning.`
        );
      }
    }

    return ["multi-discovery", discoveredOps];
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
