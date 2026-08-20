import type { IsAny, Simplify } from "../helpers/types.ts";
import type {
  ResolveSchema,
  ValidSchemaInput,
  ValidSchemaOutput,
} from "../helpers/validators/index.ts";
import type {
  MinimalEventPayload,
  PayloadForAnyInngestFunction,
} from "../types.ts";
import type { GetFunctionOutput } from "./Inngest.ts";
import type { InngestFunction } from "./InngestFunction.ts";

/**
 * A reference to an `InngestFunction` that can be used to represent both local
 * and remote functions without pulling in the full function definition (i.e.
 * dependencies).
 *
 * These references can be invoked in the same manner as a regular
 * `InngestFunction`.
 *
 * To create a reference function, use the {@link referenceFunction} helper.
 *
 * @public
 */
export class InngestFunctionReference<
  /**
   * The payload expected by the referenced function.
   *
   * Must be in the shape of an event payload.
   */
  _TInput extends MinimalEventPayload,
  /**
   * The output of the referenced function.
   */
  _TOutput,
> {
  get [Symbol.toStringTag](): typeof InngestFunctionReference.Tag {
    return InngestFunctionReference.Tag;
  }

  constructor(public readonly opts: { functionId: string; appId?: string }) {}
}

/**
 * Create a reference to an `InngestFunction` that can be used to represent both
 * local and remote functions without pulling in the full function definition
 * (i.e. dependencies).
 *
 * These references can be invoked in the same manner as a regular
 * `InngestFunction`.
 *
 * @public
 */
export const referenceFunction = <
  TArgs extends InngestFunctionReference.HelperGenericArgs<TFnInput, TFnOutput>,
  TFnInput extends ValidSchemaInput = ValidSchemaInput,
  TFnOutput extends ValidSchemaOutput = ValidSchemaOutput,
>({
  functionId,
  appId,
}: TArgs extends InngestFunction.Any
  ? // biome-ignore lint/suspicious/noExplicitAny: intentional
    Omit<InngestFunctionReference.HelperArgs<any, any>, "schemas">
  : TArgs): InngestFunctionReference.HelperReturn<TArgs> => {
  return new InngestFunctionReference({
    functionId,
    appId,
  }) as InngestFunctionReference.HelperReturn<TArgs>;
};

/**
 * A reference to an `InngestFunction` that can be used to represent both local
 * and remote functions without pulling in the full function definition (i.e.
 * dependencies).
 *
 * These references can be invoked in the same manner as a regular
 * `InngestFunction`.
 *
 * To create a reference function, use the {@link referenceFunction} helper.
 *
 * @public
 */
export namespace InngestFunctionReference {
  export const Tag = "Inngest.FunctionReference" as const;

  /**
   * Represents any `InngestFunctionReference`.
   *
   * @public
   */
  export type Any = InngestFunctionReference<
    MinimalEventPayload,
    // biome-ignore lint/suspicious/noExplicitAny: intentional
    any
  >;

  export interface Like {
    readonly [Symbol.toStringTag]: typeof InngestFunctionReference.Tag;
  }

  /**
   * Arguments used by {@link referenceFunction} to create a reference to an
   * `InngestFunction`.
   *
   * @public
   */
  export type HelperArgs<TFnInput, TFnOutput> = {
    /**
     * The ID of the function to reference. This can be either a local function
     * ID or the ID of a function that exists in another app.
     *
     * If the latter, `appId` must also be provided. If `appId` is not provided,
     * the function ID will be assumed to be a local function ID (the app ID of
     * the calling app will be used).
     */
    functionId: string;

    /**
     * The ID of the app that the function belongs to. This is only required if
     * the function being referenced exists in another app.
     */
    appId?: string;

    /**
     * The schemas of the referenced function, providing typing to the input
     * `data` and `return` of invoking the referenced function.
     *
     * If not provided and a local function type is not being passed as a
     * generic into {@link referenceFunction}, the schemas will be inferred as
     * `unknown`.
     */
    schemas?: {
      data?: TFnInput;
      return?: TFnOutput;
    };
  };

  /**
   * A helper type that allows the passing of either `HelperArgs` or
   * `InngestFunction.Any` to the {@link referenceFunction} generic in place of
   * inferring options.
   *
   * This is used along with defaults to allow a generic to be passed by the
   * user and still infer the correct types for other arguments being passed in.
   *
   * @public
   */
  export type HelperGenericArgs<TFnInput, TFnOutput> =
    | HelperArgs<TFnInput, TFnOutput>
    | InngestFunction.Any;

  /**
   * Given a set of `InngestFunctionReference.ConstructorArgs`, return an
   * `InngestFunctionReference`. Also handles the manual passing of
   * `InngestFunction.Any` to the {@link referenceFunction} generic in place
   * of inferring options.
   *
   * @public
   */
  export type HelperReturn<TArgs> = TArgs extends InngestFunction.Any
    ? InngestFunctionReference<
        PayloadForAnyInngestFunction<TArgs>,
        GetFunctionOutput<TArgs>
      >
    : TArgs extends HelperArgs<infer TFnInput, infer TFnOutput>
      ? InngestFunctionReference<
          // biome-ignore lint/suspicious/noExplicitAny: intentional
          IsAny<ResolveSchema<TFnInput, TFnInput, any>> extends true
            ? MinimalEventPayload
            : Simplify<
                // biome-ignore lint/suspicious/noExplicitAny: intentional
                MinimalEventPayload<ResolveSchema<TFnInput, TFnInput, any>> &
                  Required<
                    Pick<
                      MinimalEventPayload<
                        // biome-ignore lint/suspicious/noExplicitAny: intentional
                        ResolveSchema<TFnInput, TFnInput, any>
                      >,
                      "data"
                    >
                  >
              >,
          ResolveSchema<TFnOutput, TFnOutput, unknown>
        >
      : never;
}
