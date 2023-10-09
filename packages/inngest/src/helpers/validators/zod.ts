/**
 * Shim for Zod types to ensure hopeful compatibility between minor versions to
 * ensure that users can utilize the latest version of Zod without having to
 * wait for Inngest to update.
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

export type AnyZodObject = ZodObject<any>;

export type ZodAny = {
  _any: true;
};

export type infer<T extends ZodTypeAny> = T["_output"];
