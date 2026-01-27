import path from "path";
import { Middleware } from "../../../src/index.ts";
import { StepError } from "../../components/StepError";

export function randomSuffix(value: string): string {
  return `${value}-${Math.random().toString(36).substring(2, 15)}`;
}

export function testNameFromFileUrl(fileUrl: string): string {
  const basename = path.basename(fileUrl).split(".")[0];
  if (!basename) {
    throw new Error("unreachable");
  }
  return basename;
}

export function assertStepError(
  actual: unknown,
  expected: {
    cause?: {
      message: string;
      name: string;
    };
    message: string;
    name: string;
  },
): void {
  expect(actual).toBeInstanceOf(StepError);
  const stepError = actual as StepError;
  expect(stepError.message).toBe(expected.message);
  expect(stepError.name).toBe(expected.name);

  if (expected.cause) {
    expect(stepError.cause).toBeInstanceOf(Error);
    const cause = stepError.cause as Error;
    expect(cause.message).toBe(expected.cause.message);
    expect(cause.name).toBe(expected.cause.name);
  }
}

interface BaseSerializerMiddlewareOpts<TSerialized> {
  deserialize(value: unknown): unknown;
  isSerialized(value: unknown): value is TSerialized;
  needsSerialize(value: unknown): boolean;
  recursive?: boolean;
  serialize(value: unknown): TSerialized;
}

export abstract class BaseSerializerMiddleware<
  TSerialized,
> extends Middleware.BaseMiddleware {
  private readonly opts: BaseSerializerMiddlewareOpts<TSerialized>;

  constructor(opts: BaseSerializerMiddlewareOpts<TSerialized>) {
    super();
    this.opts = opts;
  }

  private canRecurse(): boolean {
    return this.opts.recursive ?? true;
  }

  deserialize(value: unknown): unknown {
    if (this.opts.isSerialized(value)) {
      return this.opts.deserialize(value);
    }

    if (!this.canRecurse()) {
      return value;
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          key,
          this.deserialize(value),
        ]),
      );
    }

    if (Array.isArray(value)) {
      return value.map(this.deserialize);
    }

    return value;
  }

  serialize(value: unknown): unknown {
    if (this.opts.needsSerialize(value)) {
      return this.opts.serialize(value);
    }

    if (!this.canRecurse()) {
      return value;
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => {
          return [key, this.serialize(value)];
        }),
      );
    }

    if (Array.isArray(value)) {
      return value.map(this.serialize);
    }

    return value;
  }

  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs {
    return {
      ...arg,
      ctx: {
        ...arg.ctx,
        event: {
          ...arg.ctx.event,
          data: this.deserialize(arg.ctx.event.data),
        },
        // @ts-expect-error - It's OK
        events: arg.ctx.events.map((event) => ({
          ...event,
          data: this.deserialize(event.data),
        })),
      },
    };
  }

  override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
    return async ({ next }) => {
      const output = await next();
      return this.serialize(output);
    };
  }

  override wrapStep(stepInfo: Middleware.StepInfo): Middleware.WrapStepReturn {
    // For invoke steps, serialize input in the outer function so it's
    // available before the handler chain runs (invoke steps are reported
    // to the server before handler execution).
    if (stepInfo.stepKind === "invoke") {
      stepInfo.input = stepInfo.input?.map((i) => this.serialize(i));
    }

    return async ({ next, stepOptions, input }) => {
      // For non-invoke steps, wrap the handler to serialize output
      const result = await next({ stepOptions, input });
      if (stepInfo.memoized) {
        return this.deserialize(result);
      }
      return this.serialize(result);
    };
  }

  override transformClientInput(arg: Middleware.TransformClientInputArgs) {
    if (arg.method !== "send") {
      return arg.input;
    }

    return arg.input.map((event) => ({
      ...event,
      data: event.data ? this.serialize(event.data) : event.data,
    }));
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const anyEvent = {
  data: expect.any(Object),
  id: expect.any(String),
  name: expect.any(String),
  ts: expect.any(Number),
  user: expect.any(Object),
};

export const anyContext = {
  attempt: expect.any(Number),
  event: anyEvent,
  events: [anyEvent],
  maxAttempts: expect.any(Number),
  runId: expect.any(String),
  step: expect.any(Object),
};

export async function sleep(ms: number = 1000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrapper around `vitest.waitFor` with a 10-second default timeout.
 */
export const waitFor: typeof vitest.waitFor = (callback, timeout = 10_000) => {
  return vitest.waitFor(callback, timeout);
};
