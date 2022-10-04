import { InngestFunction } from "../components/InngestFunction";
import { InngestStep } from "../components/InngestStep";
import type { EventPayload, FunctionOptions, StepFn } from "../types";
import type { EventName } from "./types";

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
  event: EventName<Event>,

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
   * "* * * * *" // Every minute
   * "0 * * * *" // Every hour
   * "0 0 * * *" // At the start of every day
   * "0 0 0 * *" // At the start of the first day of the month
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
