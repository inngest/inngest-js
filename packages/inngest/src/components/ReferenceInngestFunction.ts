import {
  type ResolveSchema,
  type ValidSchemaInput,
  type ValidSchemaOutput,
} from "../helpers/validators";
import {
  type MinimalEventPayload,
  type PayloadFromAnyInngestFunction,
} from "../types";
import { type GetFunctionOutput } from "./Inngest";
import { type AnyInngestFunction } from "./InngestFunction";

/**
 * TODO
 *
 * @public
 */
export type AnyReferenceInngestFunction = ReferenceInngestFunction<
  MinimalEventPayload,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

/**
 * TODO
 *
 * @public
 */
export class ReferenceInngestFunction<
  _TInput extends MinimalEventPayload,
  _TOutput,
> {
  constructor(public readonly opts: { functionId: string; appId?: string }) {}
}

/**
 * TODO
 *
 * @public
 */
export type ReferenceInngestFunctionOptions<TFnInput, TFnOutput> = {
  functionId: string;
  appId?: string;
  schemas?: {
    input?: TFnInput;
    output?: TFnOutput;
  };
};

/**
 * TODO
 *
 * @public
 */
export type ReferenceArgs<TFnInput, TFnOutput> =
  | ReferenceInngestFunctionOptions<TFnInput, TFnOutput>
  | AnyInngestFunction;

/**
 * TODO
 *
 * @public
 */
export const referenceFunction = <
  TArgs extends ReferenceArgs<TFnInput, TFnOutput>,
  TFnInput extends ValidSchemaInput = ValidSchemaInput,
  TFnOutput extends ValidSchemaOutput = ValidSchemaOutput,
>({
  functionId,
  appId,
}: TArgs extends AnyInngestFunction
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Omit<ReferenceInngestFunctionOptions<any, any>, "schemas">
  : TArgs) => {
  return new ReferenceInngestFunction({
    functionId,
    appId,
  }) as ReferenceFunctionReturn<TArgs>;
};

/**
 * TODO
 *
 * @public
 */
export type ReferenceFunctionReturn<TArgs> = TArgs extends AnyInngestFunction
  ? ReferenceInngestFunction<
      PayloadFromAnyInngestFunction<TArgs>,
      GetFunctionOutput<TArgs>
    >
  : TArgs extends ReferenceInngestFunctionOptions<
        infer TFnInput,
        infer TFnOutput
      >
    ? ReferenceInngestFunction<
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        MinimalEventPayload<ResolveSchema<TFnInput, TFnInput, any>>,
        ResolveSchema<TFnOutput, TFnOutput, unknown>
      >
    : never;
