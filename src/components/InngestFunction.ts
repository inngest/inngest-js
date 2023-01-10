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
import { createStepTools } from "./InngestStepTools";

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
    runStep: string | null
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

    let pos = -1;

    do {
      if (pos >= 0) {
        state.tickOps = {};
        const incomingOp = opStack[pos] as IncomingOp;
        state.currentOp = state.allFoundOps[incomingOp.id];

        if (!state.currentOp) {
          throw new Error("BAD STACK; COULD NOT FIND OP TO RESOLVE");
        }

        if (typeof incomingOp.data !== "undefined") {
          state.currentOp.resolve(incomingOp.data);
        } else {
          state.currentOp.reject(incomingOp.error);
        }
      }

      await resolveNextTick();

      state.reset();
      pos++;
    } while (pos < opStack.length);

    if (runStep) {
      const userFnToRun = state.allFoundOps[runStep]?.fn;

      if (!userFnToRun) {
        throw new Error("Bad stack; no fn to execute; re-execute pls");
      }

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

    const discoveredOps = Object.values(state.tickOps).map<OutgoingOp>((op) => {
      return {
        op: op.op,
        id: op.id,
        name: op.name,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        opts: op.opts,
      };
    });

    return ["multi-discovery", discoveredOps];
  }

  /**
   * Generate an ID based on the function's name.
   */
  #generateId(prefix?: string) {
    return slugify([prefix || "", this.#opts.name].join("-"));
  }
}
