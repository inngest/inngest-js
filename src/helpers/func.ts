import { InngestFunction } from "../components/InngestFunction";
import { InngestStep } from "../components/InngestStep";
import { EventPayload, FunctionOptions } from "../types";

export const createFunction = <Event extends EventPayload>(
  opts: string | FunctionOptions,
  event: Event extends EventPayload
    ? {
        [K in keyof Event]: K extends "name" ? Event[K] : never;
      }[keyof Event]
    : never,
  fn: (arg: { event: Event }) => any
): InngestFunction<any> => {
  return new InngestFunction(
    typeof opts === "string" ? { name: opts } : opts,
    event as string,
    {
      step: new InngestStep(fn),
    }
  );
};
