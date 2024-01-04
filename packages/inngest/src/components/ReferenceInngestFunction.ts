import { type IsUnknown } from "type-fest";
import { type ValidZodValue, type ZodTypeAny } from "../helpers/validators/zod";
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReferenceInngestFunction = ReferenceInngestFunction<any, any>;

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
  TFnInput extends ValidZodValue = ValidZodValue,
  TFnOutput extends ZodTypeAny = ZodTypeAny,
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
export type ReferenceFunctionReturn<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TArgs extends ReferenceInngestFunctionOptions<any, any> | AnyInngestFunction,
> = TArgs extends AnyInngestFunction
  ? ReferenceInngestFunction<
      PayloadFromAnyInngestFunction<TArgs>,
      GetFunctionOutput<TArgs>
    >
  : TArgs extends ReferenceInngestFunctionOptions<
        infer TFnInput,
        infer TFnOutput
      >
    ? ReferenceInngestFunction<
        IsUnknown<TFnInput> extends true
          ? MinimalEventPayload
          : TFnInput extends ZodTypeAny
            ? MinimalEventPayload<TFnInput["_output"]>
            : MinimalEventPayload<TFnInput>,
        IsUnknown<TFnOutput> extends true
          ? unknown
          : TFnOutput extends ZodTypeAny
            ? TFnOutput["_output"]
            : TFnOutput
      >
    : never;
