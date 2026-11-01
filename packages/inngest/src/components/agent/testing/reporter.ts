/**
 * @module
 * EXPERIMENTAL: a `report` for tests of an app's channels. It is the reporter
 * an agent gets, with its steps run on the spot instead of by an executor.
 */
import {
  type Channel,
  createReporter,
  type ReportConfig,
  type Reporter,
} from "../channels.ts";

/**
 * What `testReporter()` returns.
 */
export interface TestReporter {
  /**
   * The reporter, as the agent's `report`.
   */
  report: Reporter;

  /**
   * The IDs of the steps that ran, in order. A step replayed from `saved` is
   * not listed.
   */
  ran: string[];

  /**
   * The results of the steps that ran, by step ID. Pass them as `saved` to
   * `testReporter()` to replay.
   */
  results: Record<string, unknown>;
}

/**
 * Wraps `createReporter` so `status`, `card` and `begin` resolve once their
 * write has finished, for tests of what a write does. A real call does not
 * wait.
 */
export const createWaitingReporter = (
  ...args: Parameters<typeof createReporter>
): Reporter => {
  const raw = createReporter(...args);
  const waits = (name: "status" | "card" | "begin") => {
    return async (...rest: never[]) => {
      await (raw[name] as (...a: never[]) => Promise<void>)(...rest);
      await raw.settled();
    };
  };

  return Object.assign(
    (...rest: Parameters<Reporter>) => {
      return raw(...rest);
    },
    {
      status: waits("status"),
      card: waits("card"),
      begin: waits("begin"),
      finish: raw.finish,
      settled: raw.settled,
    },
  ) as unknown as Reporter;
};

/**
 * A reporter for a test: every `report()`, `report.card()` and
 * `report.finish()` runs its step directly against `channels` (`status`, `card`
 * and `begin` resolve once their write has finished), so the test
 * asserts on what the channels were sent, on the step IDs, and on what
 * `report.finish()` returns. Pass the `results` of one reporter as `saved` to
 * another to see what a replay does (it writes nothing again).
 *
 * @example
 * ```ts
 * const { report } = testReporter({ main: channel });
 * const ref = await report.finish({ text: "Done." });
 * ```
 */
export const testReporter = (
  /**
   * The channels by name, as the agent's `channels`.
   */
  channels: Record<string, Channel>,

  options: {
    /**
     * The agent's `report` config. Default: the channel named `main`.
     */
    report?: ReportConfig;

    /**
     * Step results to replay, by step ID.
     */
    saved?: Record<string, unknown>;
  } = {},
): TestReporter => {
  const { saved = {} } = options;
  const results: Record<string, unknown> = {};
  const ran: string[] = [];

  const report = createWaitingReporter(
    channels,
    options.report,
    async (id, fn) => {
      if (id in saved) {
        return saved[id];
      }

      ran.push(id);
      results[id] = await fn();

      return results[id];
    },
  );

  return { report, ran, results };
};
