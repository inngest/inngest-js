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

  override transformRunInput(arg: Middleware.TransformRunInputArgs) {
    return {
      ...arg,
      runInfo: {
        ...arg.runInfo,
        event: {
          ...arg.runInfo.event,
          data: this.deserialize(arg.runInfo.event.data),
        },
        events: arg.runInfo.events.map((event) => ({
          ...event,
          data: this.deserialize(event.data),
        })),
      },
    };
  }

  override transformRunOutput(arg: Middleware.TransformRunOutputArgs) {
    return this.serialize(arg.output);
  }

  override transformStepInput(arg: Middleware.TransformStepInputArgs) {
    // For invoke steps, serialize the input data being sent to the invoked
    // function
    if (arg.stepInfo.stepKind === "invoke") {
      return {
        ...arg,
        stepInfo: {
          ...arg.stepInfo,
          input: arg.stepInfo.input?.map((i) => this.serialize(i)),
        },
      };
    }

    // For other steps (run, sendEvent), wrap the handler to serialize output
    return {
      ...arg,
      handler: async () => {
        const result = await arg.handler();
        return this.serialize(result);
      },
    };
  }

  override transformStepOutput(arg: Middleware.TransformStepOutputArgs) {
    return this.deserialize(arg.output);
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
