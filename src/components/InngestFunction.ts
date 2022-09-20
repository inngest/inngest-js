import { fnIdParam, stepIdParam } from "../helpers/consts";
import {
  EventPayload,
  FunctionConfig,
  FunctionOptions,
  FunctionTrigger,
  Steps,
} from "../types";

export class InngestFunction<Events extends Record<string, EventPayload>> {
  readonly #opts: FunctionOptions;
  readonly #trigger: FunctionTrigger<keyof Events>;
  readonly #steps: Steps;

  constructor(
    opts: FunctionOptions,
    trigger: FunctionTrigger<keyof Events>,
    steps: Steps
  ) {
    this.#opts = opts;
    this.#trigger = trigger;
    this.#steps = steps || {};
  }

  public get id() {
    return this.#opts.id || this.#generateId();
  }

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
    baseUrl: URL
  ): FunctionConfig {
    return {
      id: this.id,
      name: this.name,
      triggers: [this.#trigger as FunctionTrigger],
      steps: Object.keys(this.#steps).reduce<FunctionConfig["steps"]>(
        (acc, stepId) => {
          const url = new URL(baseUrl.href);
          url.searchParams.set(fnIdParam, this.#opts.name);
          url.searchParams.set(stepIdParam, stepId);

          return {
            ...acc,
            [stepId]: {
              id: stepId,
              name: stepId,
              runtime: {
                type: "http",
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

  #generateId() {
    const join = "-";

    return this.#opts.name
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, join)
      .replaceAll(/-+/g, join)
      .split(join)
      .filter(Boolean)
      .join(join);
  }
}
