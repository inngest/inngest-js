import { Inngest } from "./Inngest";

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

  private async run(data: any): Promise<unknown> {
    return this.#fn(data);
  }
}
