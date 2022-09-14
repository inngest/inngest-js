import { InngestFunction } from "../components/InngestFunction";
import { InngestStep } from "../components/InngestStep";
import { EventPayload, FunctionOptions, StepFn } from "../types";

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
    event as string,
    {
      step: new InngestStep(fn),
    }
  );
};
