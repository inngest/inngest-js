import { jest } from "@jest/globals";
import { Context } from "inngest/types";

/**
 * The default context transformation function that mocks all step tools. Use
 * this in addition to your custom transformation function if you'd like to keep
 * this functionality.
 */
export const mockCtx = (ctx: Readonly<Context.Any>): Context.Any => {
  const step = Object.keys(ctx.step).reduce(
    (acc, key) => {
      const tool = ctx.step[key as keyof typeof ctx.step];
      const mock = jest.fn(tool);

      return {
        ...acc,
        [key]: mock,
      };
    },
    {} as Context.Any["step"]
  );

  return {
    ...ctx,
    step,
  };
};
