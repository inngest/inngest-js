import type { StandardSchemaV1 } from "@standard-schema/spec";
import { internalEvents } from "../helpers/consts.ts";
import { type Marker, markerKey } from "../helpers/marker.ts";
import type {
  ApplyAllMiddlewareCtxExtensions,
  ApplyAllMiddlewareStepExtensions,
  BaseContext,
  FunctionConfig,
  Handler,
} from "../types.ts";
import type {
  builtInMiddleware,
  ClientOptionsFromInngest,
  Inngest,
} from "./Inngest.ts";
import { InngestFunction } from "./InngestFunction.ts";
import type { createStepTools } from "./InngestStepTools.ts";
import type { Middleware } from "./middleware/index.ts";

const idDenyRegex = /['\\\n\r]/;

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * A defer (companion) function created via `createDefer(...)`. Real
 * `InngestFunction` at runtime, but with the trigger pinned to
 * `inngest/deferred.schedule` (see `getConfigTriggers`), `triggers` and
 * `onFailure` disallowed, and the schema carried as a typed instance
 * property so callers of `defer(id, { function, data })` can extract it.
 *
 * Identify a defer function at runtime via `isDeferredFunction(value)` from
 * `helpers/marker.ts`. Prefer that over `instanceof`, which fails across
 * duplicate SDK copies in the same process.
 *
 * @public
 */
export class DeferredFunction<
  TSchema extends
    | StandardSchemaV1<Record<string, unknown>>
    | undefined = undefined,
> extends InngestFunction<
  InngestFunction.Options<[], never>,
  Handler.Any,
  never,
  Inngest.Any,
  []
> {
  readonly schema: TSchema;
  readonly [markerKey]: Marker = { kind: "deferredFunction" };

  constructor(
    client: Inngest.Any,
    opts: DeferredFunction.Options,
    handler: Handler.Any,
    schema: TSchema,
  ) {
    // The id is interpolated into a CEL trigger expression
    // (`event.data._inngest.fn_slug == '${fnId}'`). Reject characters that
    // would break the single-quoted string literal.
    if (idDenyRegex.test(opts.id)) {
      throw new Error(
        `invalid id "${opts.id}"; must match ${idDenyRegex.source}`,
      );
    }
    super(
      client,
      { ...opts, triggers: [] } as InngestFunction.Options<[], never>,
      handler,
    );
    this.schema = schema;
  }

  protected override getConfigTriggers(
    fnId: string,
  ): FunctionConfig["triggers"] {
    return [
      {
        event: internalEvents.DeferredSchedule,
        expression: `event.data._inngest.fn_slug == '${fnId}'`,
      },
    ];
  }
}

/**
 * @public
 */
export namespace DeferredFunction {
  /**
   * Matches any `DeferredFunction` regardless of its schema. Use as the
   * constraint for the `function` argument of `defer()`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: widest schema constraint for inference
  export type Any = DeferredFunction<StandardSchemaV1<any> | undefined>;

  /**
   * The user-facing options accepted by `createDefer(client, opts, handler)`.
   * Mirrors `InngestFunction.Options` minus `triggers` (implicit), `onFailure`
   * (not yet supported), and `batchEvents` (each `defer(...)` is its own run).
   */
  export type Options = Omit<
    InngestFunction.Options<[], never>,
    "triggers" | "onFailure" | "batchEvents"
  >;
}

/**
 * The `event` shape a defer handler receives. With a schema, `data`
 * narrows to its inferred type; without one, it falls back to
 * `Record<string, any>`.
 */
type DeferEvent<TSchema> = {
  name: internalEvents.DeferredSchedule;
  data: TSchema extends StandardSchemaV1<
    infer D extends Record<string, unknown>
  >
    ? D
    : // biome-ignore lint/suspicious/noExplicitAny: no schema = any
      Record<string, any>;
};

/**
 * Base ctx shape for a defer handler: the standard function context
 * (`runId`, `attempt`, `group`, `step` with middleware step extensions)
 * with `event`/`events` pinned to `inngest/deferred.schedule` and the
 * schema-typed payload.
 */
type BaseDeferCtx<
  TClient extends Inngest.Any,
  TFnMiddleware extends Middleware.Class[] | undefined,
  TSchema extends StandardSchemaV1<Record<string, unknown>> | undefined,
> = Omit<BaseContext<TClient>, "event" | "events" | "step"> & {
  event: DeferEvent<TSchema>;
  events: [DeferEvent<TSchema>];
  step: ReturnType<typeof createStepTools<TClient, TFnMiddleware>> &
    ApplyAllMiddlewareStepExtensions<
      ClientOptionsFromInngest<TClient>["middleware"]
    > &
    ApplyAllMiddlewareStepExtensions<TFnMiddleware>;
};

/**
 * Input type for `createDefer`. Same shape as `DeferredFunction.Options`
 * plus `schema` (the StandardSchema describing `event.data` that flows
 * to caller `defer(id, { function, data })` call sites) and `middleware`.
 */
export type CreateDeferInput<
  TFnMiddleware extends Middleware.Class[] | undefined,
  TSchema extends StandardSchemaV1<Record<string, unknown>> | undefined,
> = DeferredFunction.Options & {
  schema?: TSchema;
  middleware?: TFnMiddleware;
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Create a typed defer function. One `createDefer` call = one Inngest
 * function. Returns a `DeferredFunction<TSchema>` so callers of `defer(id,
 * { function, data })` get the data type inferred from the schema.
 *
 * Mirrors `inngest.createFunction(opts, handler)`, with three differences:
 * the client is the first positional arg, `triggers` is not accepted (the
 * SDK emits an implicit `inngest/deferred.schedule` trigger), and `schema`
 * describes the payload that callers will send via `defer(id, { function,
 * data })`.
 *
 * Pass the result to `serve()` alongside regular functions so the SDK
 * registers it.
 */
export function createDefer<
  TClient extends Inngest.Any,
  TSchema extends
    | StandardSchemaV1<Record<string, unknown>>
    | undefined = undefined,
  const TFnMiddleware extends Middleware.Class[] | undefined = undefined,
  THandler extends Handler.Any = (
    ctx: BaseDeferCtx<TClient, TFnMiddleware, TSchema> &
      ApplyAllMiddlewareCtxExtensions<
        [...ReturnType<typeof builtInMiddleware>]
      > &
      ApplyAllMiddlewareCtxExtensions<
        ClientOptionsFromInngest<TClient>["middleware"]
      > &
      ApplyAllMiddlewareCtxExtensions<TFnMiddleware>,
  ) => unknown,
>(
  client: TClient,
  options: CreateDeferInput<TFnMiddleware, TSchema>,
  handler: THandler,
): DeferredFunction<TSchema> {
  const { schema, ...rest } = options;
  return new DeferredFunction<TSchema>(
    client,
    rest,
    handler as Handler.Any,
    schema as TSchema,
  );
}
