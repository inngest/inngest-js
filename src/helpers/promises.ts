/**
 * A helper function to create a `Promise` that will never settle.
 *
 * It purposefully creates no references to `resolve` or `reject` so that the
 * returned `Promise` will remain unsettled until it falls out of scope and is
 * garbage collected.
 *
 * This should be used within transient closures to fake asynchronous action, so
 * long as it's guaranteed that they will fall out of scope.
 */
export const createFrozenPromise = (): Promise<unknown> => {
  return new Promise(() => undefined);
};

/**
 * Returns a Promise that will resolve next tick.
 */
export const resolveNextTick = (): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve));
};

/**
 * A class to manage timing functions and arbitrary periods of time before
 * generating a `Server-Timing` header for use in HTTP responses.
 *
 * This is a very simple implementation that does not support nested timings or
 * fractions of a millisecond.
 */
export class ServerTiming {
  #timings: Record<
    string,
    { description: string; start?: number; end?: number }
  > = {};

  /**
   * Start a timing. Returns a function that, when called, will stop the timing
   * and add it to the header.
   */
  public start(name: string, description?: string): () => void {
    if (this.#timings[name]) {
      console.warn(`Timing "${name}" already exists`);
      return (): void => undefined;
    }

    this.#timings[name] = {
      description: description ?? "",
      start: Date.now(),
    };

    return (): void => {
      const target = this.#timings[name];

      if (!target) {
        return console.warn(`Timing "${name}" does not exist`);
      }

      target.end = Date.now();
    };
  }

  /**
   * Add a piece of arbitrary, untimed information to the header. Common use
   * cases would be cache misses.
   *
   * @example
   * ```
   * timer.append("cache", "miss");
   * ```
   */
  public append(key: string, value: string): void {
    this.#timings[key] = {
      description: value,
    };
  }

  /**
   * Wrap a function in a timing. The timing will be stopped and added to the
   * header when the function resolves or rejects.
   *
   * The return value of the function will be returned from this function.
   */
  public async wrap<T extends (...args: any[]) => any>(
    name: string,
    fn: T,
    description?: string
  ): Promise<Awaited<ReturnType<T>>> {
    const stop = this.start(name, description);

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return await Promise.resolve(fn());
    } finally {
      stop();
    }
  }

  /**
   * Generate the `Server-Timing` header.
   */
  public getHeader(): string {
    const entries = Object.entries(this.#timings).reduce<string[]>(
      (acc, [name, { description, start, end }]) => {
        /**
         * Ignore timings that started but never ended.
         */
        if (start && !end) return acc;

        const entry = [
          name,
          description ? `desc="${description}"` : "",
          start && end ? `dur=${end - start}` : "",
        ]
          .filter(Boolean)
          .join(";");

        return [...acc, entry];
      },
      []
    );

    return entries.join(", ");
  }
}
