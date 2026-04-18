import { Middleware } from "../../../src/index.ts";
import { StepError } from "../../components/StepError";

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

export abstract class BaseSerializerMiddleware<
  TSerialized,
> extends Middleware.BaseMiddleware {
  abstract override readonly id: string;
  protected abstract deserialize(value: TSerialized): unknown;
  protected abstract isSerialized(value: unknown): value is TSerialized;
  protected abstract needsSerialize(value: unknown): boolean;
  protected abstract serialize(value: unknown): TSerialized;

  protected readonly recursive: boolean = true;

  private _deserialize(value: unknown): unknown {
    if (this.isSerialized(value)) {
      return this.deserialize(value);
    }

    if (!this.recursive) {
      return value;
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          key,
          this._deserialize(value),
        ]),
      );
    }

    if (Array.isArray(value)) {
      return value.map((v) => this._deserialize(v));
    }

    return value;
  }

  private _serialize(value: unknown): unknown {
    if (this.needsSerialize(value)) {
      return this.serialize(value);
    }

    if (!this.recursive) {
      return value;
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => {
          return [key, this._serialize(value)];
        }),
      );
    }

    if (Array.isArray(value)) {
      return value.map((v) => this._serialize(v));
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
          data: this._deserialize(arg.ctx.event.data),
        },
        // @ts-expect-error - It's OK
        events: arg.ctx.events.map((event) => ({
          ...event,
          data: this._deserialize(event.data),
        })),
      },
    };
  }

  override async wrapFunctionHandler({
    next,
  }: Middleware.WrapFunctionHandlerArgs) {
    const output = await next();
    return this._serialize(output);
  }

  override transformStepInput(
    arg: Middleware.TransformStepInputArgs,
  ): Middleware.TransformStepInputArgs {
    // For invoke steps, serialize input so it's available before the handler
    // chain runs (invoke steps are reported to the server before execution).
    if (arg.stepInfo.stepType === "invoke") {
      arg.input = arg.input.map((i) => this._serialize(i));
    }
    return arg;
  }

  override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
    const output = await next();
    return this._serialize(output);
  }

  override async wrapStep({ next }: Middleware.WrapStepArgs) {
    return this._deserialize(await next());
  }

  override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
    return {
      ...arg,
      events: arg.events.map((event) => {
        let data = undefined;
        if (event.data) {
          data = this._serialize(event.data) as Record<string, unknown>;
        }

        return {
          ...event,
          data,
        };
      }),
    };
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
  group: expect.any(Object),
  logger: expect.any(Object),
  maxAttempts: expect.any(Number),
  runId: expect.any(String),
  step: expect.any(Object),
};

export { fetchEvent } from "@inngest/test-harness";

/**
 * Runs a test in both checkpointing modes (false and true).
 */
export function matrixCheckpointing(
  name: string,
  fn: (checkpointing: boolean) => Promise<void>,
) {
  describe(name, () => {
    for (const checkpointing of [false, true]) {
      test(`checkpointing: ${checkpointing}`, () => fn(checkpointing));
    }
  });
}
