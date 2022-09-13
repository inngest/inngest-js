import { Inngest } from "./Inngest";

/**
 * A typed, individual step within an `InngestFunction`.
 */
export class InngestStep<
  Events extends Record<string, any>,
  Input extends any[],
  Output
> {
  readonly #inngest: Inngest<Events>;
  readonly #fn: (...args: any) => Output;

  constructor(inngest: Inngest<Events>, fn: (...args: Input) => Output) {
    this.#inngest = inngest;
    this.#fn = fn;
  }

  /**
   * Run this step with the given `data`.
   */
  private async run(data: any): Promise<unknown> {
    return this.#fn(data);
  }
}
