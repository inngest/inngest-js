import type { StandardSchemaV1 } from "@standard-schema/spec";
import { internalEvents } from "../helpers/consts.ts";
import type { FunctionConfig, Handler } from "../types.ts";
import type { Inngest } from "./Inngest.ts";
import { InngestFunction } from "./InngestFunction.ts";

const idRegex = /^[a-zA-Z0-9_-]+$/;

/**
 * A defer (companion) function created via `createDefer(...)`. Real
 * `InngestFunction` at runtime, but with the trigger pinned to
 * `inngest/deferred.schedule` (see `getConfigTriggers`), `triggers` and
 * `onFailure` disallowed, and the schema carried as a typed instance
 * property so callers of `defer(id, { function, data })` can extract it.
 *
 * Identify a defer function at runtime via `instanceof DeferredFunction`.
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

  constructor(
    client: Inngest.Any,
    opts: DeferredFunction.Options,
    handler: Handler.Any,
    schema: TSchema,
  ) {
    // The id is interpolated into a CEL trigger expression
    // (`event.data._inngest.fn_slug == '${fnId}'`). Reject characters that
    // would break the expression syntactically or broaden the trigger.
    if (!idRegex.test(opts.id)) {
      throw new Error(`invalid id "${opts.id}"; must match ${idRegex.source}`);
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
