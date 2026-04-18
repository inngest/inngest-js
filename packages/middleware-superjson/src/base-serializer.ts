import { Middleware } from "inngest";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrower than {@link isRecord}: returns `true` only for objects whose
 * prototype is `Object.prototype` or `null` (i.e. literal `{...}` or
 * `Object.create(null)`). Class instances, Maps, Sets, Dates etc. return
 * `false`.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
    console.log("serialize", value)
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
    console.log("transformStepInput before", JSON.stringify(arg.input, null, 2))
    // For invoke steps, serialize input so it's available before the handler
    // chain runs (invoke steps are reported to the server before execution).
    if (arg.stepInfo.stepType === "invoke") {
      arg.input = arg.input.map((i) => {
        if (!isRecord(i)) {
          return i;
        }
        return {
          ...i,
          payload: this._serialize(i.payload),
        }
      });
    }
    console.log("transformStepInput after", JSON.stringify(arg.input, null, 2))
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
