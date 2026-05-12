import type { StandardSchemaV1 } from "@standard-schema/spec";
import { internalEvents } from "../helpers/consts.ts";
import { type Marker, markerKey } from "../helpers/marker.ts";
import type {
  ApplyAllMiddlewareCtxExtensions,
  ApplyAllMiddlewareStepExtensions,
  BaseContext,
  Context,
  FunctionConfig,
  Handler,
} from "../types.ts";
import type { IInngestExecution } from "./execution/InngestExecution.ts";
import type {
  builtInMiddleware,
  ClientOptionsFromInngest,
  Inngest,
} from "./Inngest.ts";
import {
  type CreateExecutionOptions,
  InngestFunction,
} from "./InngestFunction.ts";
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

  protected override createExecution(
    opts: CreateExecutionOptions,
  ): IInngestExecution {
    return super.createExecution({
      ...opts,
      partialOptions: {
        ...opts.partialOptions,
        transformCtx: (ctx) => this.transformContext(ctx),
      },
    });
  }

  /**
   * Hook for massaging the handler context before middleware and user code
   * run. Reshapes each event's `data` from the wire format
   * `{ ...userInput, _inngest }` to `{ parent, input }` so handlers (and
   * batched future calls where parents may differ per event) can see the
   * routing metadata alongside their typed payload. Subclasses can
   * override to change behavior.
   */
  protected transformContext(ctx: Context.Any): Context.Any {
    const reshape = (data: Record<string, unknown>) => {
      const { _inngest, ...input } = data;
      const meta = (_inngest ?? {}) as {
        parent_fn_slug?: string;
        parent_run_id?: string;
      };
      return {
        parent: {
          fnSlug: meta.parent_fn_slug ?? "",
          runId: meta.parent_run_id ?? "",
        } satisfies DeferredFunction.Parent,
        input,
      };
    };
    ctx.event.data = reshape(ctx.event.data as Record<string, unknown>);
    for (const event of ctx.events) {
      event.data = reshape(event.data as Record<string, unknown>);
    }
    return ctx;
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

  /**
   * Routing metadata describing the parent run that triggered a defer
   * handler. Derived from `event.data._inngest` on the wire and surfaced
   * on each handler event as `data.parent`.
   */
  export type Parent = {
    fnSlug: string;
    runId: string;
  };
}

/**
 * The `event` shape a defer handler receives. `data.parent` carries the
 * backend's routing metadata for this event (per-event so future batched
 * deliveries can mix parents); `data.input` carries the user payload —
 * narrowed by the schema if one is set, otherwise `Record<string, any>`.
 */
type DeferEvent<TSchema> = {
  name: internalEvents.DeferredSchedule;
  data: {
    parent: DeferredFunction.Parent;
    input: TSchema extends StandardSchemaV1<
      infer D extends Record<string, unknown>
    >
      ? D
      : // biome-ignore lint/suspicious/noExplicitAny: no schema = any
        Record<string, any>;
  };
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
