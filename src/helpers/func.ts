import { InngestFunction } from "../components/InngestFunction";
import type {
  EventPayload,
  FunctionOptions,
  MultiStepFn,
  SingleStepFn,
} from "../types";
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
  fn: SingleStepFn<Event, string, "step">
): InngestFunction<any> => {
  return new InngestFunction(
    typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
    { event: event as string },
    fn
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
  fn: SingleStepFn<null, string, "step">
): InngestFunction<any> => {
  return new InngestFunction(
    typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
    { cron },
    fn
  );
};

/**
 * Given an event to listen to, run the given step function when that event is
 * seen.
 *
 * These can be used to build multi-step, serverless workflows with delays,
 * conditional logic, and coordination between events.
 *
 * @public
 */
export const createStepFunction = <
  Events extends Record<string, EventPayload>,
  Event extends keyof Events
>(
  /**
   * The name or options for this Inngest function - providing options is
   * useful for defining a custom ID.
   */
  nameOrOpts: string | FunctionOptions,

  /**
   * The event to listen for.
   */
  event: EventName<Events[Event]>,

  /**
   * The function to run when the event is received.
   */
  fn: MultiStepFn<Events, Event, string, "step">
): InngestFunction<any> => {
  return new InngestFunction(
    typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
    { event: event as string },
    fn
  );
};
