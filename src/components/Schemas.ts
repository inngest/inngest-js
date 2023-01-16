import { Simplify } from "type-fest";
import { z } from "zod";
import { EventPayload, StandardEventSchemas, ZodEventSchemas } from "../types";

/**
 * @public
 */
export class Schemas<S extends Record<string, EventPayload>> {
  public fromGenerated<T extends StandardEventSchemas>() {
    return new Schemas<Simplify<S & T>>();
  }

  public fromTypes<T extends StandardEventSchemas>() {
    return new Schemas<Simplify<S & T>>();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public fromZod<T extends ZodEventSchemas>(schemas: T) {
    return new Schemas<
      Simplify<
        S & {
          [K in keyof T & string]: {
            name: K;
            data: z.infer<T[K]["data"]>;
            user?: z.infer<NonNullable<T[K]["user"]>>;
          };
        }
      >
    >();
  }
}
