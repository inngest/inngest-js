import { InngestFunction } from "../components/InngestFunction";
import { InngestStep } from "../components/InngestStep";
import { EventPayload, FunctionOptions, StepFn } from "../types";

/**
 * Given an event to listen to, run the given function when that event is
 * seen.
 *
 * @public
 */
export const createFunction = <Event extends EventPayload>(
  /**
   * The name or options for this Inngest function - providing options is
   * useful for defining a custom ID.
   */
  nameOrOpts: string | FunctionOptions,

  /**
   * The event to listen for.
   */
  event: Event extends EventPayload
    ? {
        [K in keyof Event]: K extends "name" ? Event[K] : never;
      }[keyof Event]
    : never,

  /**
   * The function to run when the event is received.
   */
  fn: StepFn<Event, string, "step">
): InngestFunction<any> => {
  return new InngestFunction(
    typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
    { event: event as string },
    { step: new InngestStep(fn) }
  );
};

/**
 * Run the given `fn` at a specified time or on a schedule given by `cron`.
 *
 * @public
 */
export const createScheduledFunction = (
  /**
   * The name or options for this Inngest function - providing options is
   * useful for defining a custom ID.
   */
  nameOrOpts: string | FunctionOptions,

  /**
   * The cron definition to schedule your function.
   *
   * @example
   *
   * "0 0 0 1 1 * 1" // At 12:00 AM, on day 1 of the month, only in January, only in 0001
   * "0 0 0 1 1 * 1,2" // At 12:00 AM, on day 1 of the month, only in January, only in 0001 and 0002
   * "0 0 0 1 1 * 1,2,3" // At 12:00 AM, on day 1 of the month, only in January, only in 0001, 0002, and 0003
   * "0 0 0 1 * * 1/4" // At 12:00 AM, on day 1 of the month, every 4 years
   * "0 0 0 * * 0 1-4" // At 12:00 AM, only on Sunday, 0001 through 0004
   * "0 0 0 * * * 2/4" // At 12:00 AM, every 4 years, 0002 through 9999
   * "0 0 * * * * *" // Every hour
   */
  cron: string,

  /**
   * The function to run.
   */
  fn: StepFn<null, string, "step">
): InngestFunction<any> => {
  return new InngestFunction(
    typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
    { cron },
    { step: new InngestStep(fn) }
  );
};
