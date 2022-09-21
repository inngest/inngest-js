/**
 * A typed, individual step within an `InngestFunction`.
 */
export class InngestStep<Input extends any[], Output> {
  readonly #fn: (...args: any) => Output;

  constructor(fn: (...args: Input) => Output) {
    this.#fn = fn;
  }

  /**
   * Run this step with the given `data`.
   *
   * Purposefully return a promise so that it's easier to catch further up the
   * stack.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  private async run(data: any): Promise<unknown> {
    return this.#fn(data);
  }
}
