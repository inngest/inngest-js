import { runAsPromise } from "./promises.ts";
import { getLogger } from "./log.ts";

interface Timing {
  description: string;
  timers: {
    start?: number;
    end?: number;
  }[];
}

/**
 * A class to manage timing functions and arbitrary periods of time before
 * generating a `Server-Timing` header for use in HTTP responses.
 *
 * This is a very simple implementation that does not support nested timings or
 * fractions of a millisecond.
 */
export class ServerTiming {
  private timings: Record<string, Timing> = {};

  /**
   * Start a timing. Returns a function that, when called, will stop the timing
   * and add it to the header.
   */
  public start(name: string, description?: string): () => void {
    if (!this.timings[name]) {
      this.timings[name] = {
        description: description ?? "",
        timers: [],
      };
    }

    const index = this.timings[name].timers.push({ start: Date.now() }) - 1;

    return (): void => {
      const target = this.timings[name];
      if (!target) {
        return getLogger().warn(`Timing "${name}" does not exist`);
      }

      const timer = target.timers[index];
      if (!timer) {
        return getLogger().warn(
          `Timer ${index} for timing "${name}" does not exist`,
        );
      }

      timer.end = Date.now();
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
    this.timings[key] = {
      description: value,
      timers: [],
    };
  }

  /**
   * Wrap a function in a timing. The timing will be stopped and added to the
   * header when the function resolves or rejects.
   *
   * The return value of the function will be returned from this function.
   */
  public async wrap<T extends (...args: unknown[]) => unknown>(
    name: string,
    fn: T,
    description?: string,
  ): Promise<Awaited<ReturnType<T>>> {
    const stop = this.start(name, description);

    try {
      return (await runAsPromise(fn)) as Awaited<ReturnType<T>>;
    } finally {
      stop();
    }
  }

  /**
   * Generate the `Server-Timing` header.
   */
  public getHeader(): string {
    const entries = Object.entries(this.timings).reduce<string[]>(
      (acc, [name, { description, timers }]) => {
        /**
         * Ignore timers that had no end.
         */
        const hasTimersWithEnd = timers.some((timer) => timer.end);
        if (!hasTimersWithEnd) {
          return acc;
        }

        const dur = timers.reduce((acc, { start, end }) => {
          if (!start || !end) return acc;
          return acc + (end - start);
        }, 0);

        const entry = [
          name,
          description ? `desc="${description}"` : "",
          dur ? `dur=${dur}` : "",
        ]
          .filter(Boolean)
          .join(";");

        return [...acc, entry];
      },
      [],
    );

    return entries.join(", ");
  }
}
