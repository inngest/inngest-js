/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shim for Zod types to ensure hopeful compatibility between minor versions;
 * let developers the latest version of Zod without having to have Inngest match
 * the same version.
 *
 * Feels weird to be using internal properties like this, but types break across
 * minors anyway, so at least with this we rely on fewer fields staying the
 * same.
 */
export type ZodLiteral<TValue = any> = {
  get value(): TValue;
  _def: {
    typeName: "ZodLiteral";
  };
};

export type ZodTypeAny = {
  _type: any;
  _output: any;
  _input: any;
  _def: any;
};

export type ZodObject<TShape = { [k: string]: ZodTypeAny }> = {
  get shape(): TShape;
  _def: {
    typeName: "ZodObject";
  };
};

export type ZodDiscriminatedUnion = {
  _def: {
    typeName: "ZodDiscriminatedUnion";
  };
};

export type ZodUnion<
  TOptions extends (AnyZodObject | ZodDiscriminatedUnion | ZodAny)[] = (
    | AnyZodObject
    | ZodDiscriminatedUnion
    | ZodAny
  )[],
> = {
  options: TOptions;
  _def: {
    typeName: "ZodUnion";
  };
};

export type AnyZodObject = ZodObject<any>;

export type ZodAny = {
  _any: true;
};

export type ValidZodValue =
  // Allow `z.object()`
  | AnyZodObject
  // Allow `z.discriminatedUnion()`, a union of objects with a common key
  | ZodDiscriminatedUnion
  // Allow `z.any()`
  | ZodAny
  // Allow `z.union()`, only in cases where it's a union of other valid zod values
  | ZodUnion;

export type infer<T extends ZodTypeAny> = T["_output"];
