import { queryKeys } from "../helpers/consts";
import { slugify } from "../helpers/strings";
import {
  EventPayload,
  FunctionConfig,
  FunctionOptions,
  FunctionTrigger,
  GeneratorArgs,
  StepArgs,
  StepOpCode,
} from "../types";
import { InngestStepTools } from "./InngestStepTools";

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
      id: fnId,
      name: this.name,
      triggers: [this.#trigger as FunctionTrigger],
      steps: {
        step: {
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
   * Run a step in this function defined by `stepId` with `data`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  private async runFn(
    data: any,
    runStack: [StepOpCode, any][]
  ): Promise<unknown> {
    /**
     * We type `res` as a generator here, but there's a chance it might not be
     * one. We'll check for that as soon as we can.
     */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res: Generator<
      [StepOpCode, any],
      any,
      GeneratorArgs<string, string, string>
    > = await this.#fn(data);

    const isGenerator =
      Boolean(res) &&
      Object.hasOwnProperty.call(res, "next") &&
      typeof (res as { next: any }).next === "function";

    if (!isGenerator) {
      // Not a generator, return this data and handle as usual.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return res;
    }

    /**
     * First, we must skip every step we've already completed. To do this, we
     * must iterate over the generator, passing it all data we currently have,
     * step by step.
     *
     * For each of these steps, data will be returned from the generator. We
     * must ensure that our expected next step matches the next step desired by
     * the generator.
     *
     * If it does not match, we must trigger the step that is different and
     * show a warning to the user.
     *
     * If we run out of data, we will perform the last action given by the
     * generator.
     */

    for (const run of runStack) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const { value, done } = res.next({
        ...(data as StepArgs<string, string, string>),
        tools: new InngestStepTools(),
      });

      if (done) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return value;
      }

      if (op !== value.op) {
        throw new Error(
          `Expected step ${op} but got ${value.op} from generator.`
        );
      }
    }
  }

  /**
   * Generate an ID based on the function's name.
   */
  #generateId(prefix?: string) {
    return slugify([prefix || "", this.#opts.name].join("-"));
  }
}
