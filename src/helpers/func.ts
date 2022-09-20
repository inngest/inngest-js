import { InngestFunction } from "../components/InngestFunction";
import { InngestStep } from "../components/InngestStep";
import { EventPayload, FunctionOptions, StepFn } from "../types";

/**
 * @public
 */
export const createFunction = <Event extends EventPayload>(
  nameOrOpts: string | FunctionOptions,
  event: Event extends EventPayload
    ? {
        [K in keyof Event]: K extends "name" ? Event[K] : never;
      }[keyof Event]
    : never,
  fn: StepFn<Event, string, "step">
): InngestFunction<any> => {
  return new InngestFunction(
    typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
    { event: event as string },
    { step: new InngestStep(fn) }
  );
};

/**
 * @public
 */
export const createScheduledFunction = (
  nameOrOpts: string | FunctionOptions,
  cron: string,
  fn: StepFn<null, string, "step">
): InngestFunction<any> => {
  return new InngestFunction(
    typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
    { cron },
    { step: new InngestStep(fn) }
  );
};
