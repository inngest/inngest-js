import { FunctionConfig, FunctionOptions, Steps } from "../types";
import { InngestStep } from "./InngestStep";

export class InngestFunction<Events extends Record<string, any>> {
  readonly #opts: FunctionOptions;
  #trigger: keyof Events | undefined;
  readonly #steps: Steps;

  constructor(opts: FunctionOptions, trigger?: keyof Events, steps?: Steps) {
    this.#opts = opts;
    this.#trigger = trigger;
    this.#steps = steps || {};
  }

  public get name() {
    return this.#opts.name;
  }

  /**
   * Retrieve the Inngest config for this function.
   */
  private getConfig(
    /**
     * Must be provided a URL that will be used to trigger the step. This
     * function can't be expected to know how it will be accessed, so relies on
     * an outside method providing context.
     */
    url: URL
  ): FunctionConfig {
    return {
      id: this.#opts.name,
      name: this.#opts.name,
      triggers: [{ event: this.#trigger as string }],
      steps: Object.keys(this.#steps).reduce<FunctionConfig["steps"]>(
        (acc, stepId) => {
          return {
            ...acc,
            [stepId]: {
              id: stepId,
              name: stepId,
              runtime: {
                type: "remote",
                url: url.href,
              },
            },
          };
        },
        {}
      ),
    };
  }

  /**
   * Run a step in this function defined by `stepId` with `data`.
   */
  private runStep(stepId: string, data: any): Promise<unknown> {
    const step = this.#steps[stepId];
    if (!step) {
      throw new Error(
        `Could not find step with ID "${stepId}" in function "${this.name}"`
      );
    }

    return step["run"](data);
  }

  /**
   * Given an event to listen to, run the given function when that event is
   * seen.
   */
  public on<
    Event extends keyof Events,
    Fn extends (arg: { event: Events[Event] }) => any
  >(event: Event, fn: Fn): this {
    /**
     * Temporary check while we have multiple paths to the same functionality that
     * we're not overwriting steps.
     */
    if (Object.keys(this.#steps).length || this.#trigger) {
      throw new Error(
        "Cannot register steps or triggers for the same function more than once."
      );
    }

    this.#trigger = event;
    this.#steps["step"] = new InngestStep(fn);

    return this;
  }
}
