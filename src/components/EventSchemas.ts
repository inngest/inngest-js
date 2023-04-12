import { Simplify } from "type-fest";
import { z } from "zod";
import { IsStringLiteral } from "../helpers/types";
import { EventPayload } from "../types";

export type StandardEventSchema = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user?: Record<string, any>;
};

/**
 * A helper type that declares a standardised custom part of the event schema.
 *
 * @public
 */
export type StandardEventSchemas = Record<string, StandardEventSchema>;

/**
 * A helper type that declares a standardised custom part of the event schema,
 * defined using Zod.
 *
 * @public
 */
export type ZodEventSchemas = Record<
  string,
  {
    data: z.AnyZodObject | z.ZodAny;
    user?: z.AnyZodObject | z.ZodAny;
  }
>;

/**
 * A helper type to convert input schemas into the format expected by the
 * `EventSchemas` class, which ensures that each event contains all pieces
 * of information required.
 *
 * It purposefully uses slightly more complex mapped types to flatten the
 * output.
 *
 * @public
 */
export type StandardEventSchemaToPayload<T> = Simplify<{
  [K in keyof T & string]: {
    [K2 in keyof (Omit<EventPayload, keyof T[K]> & T[K] & { name: K })]: (Omit<
      EventPayload,
      keyof T[K]
    > &
      T[K] & { name: K })[K2];
  };
}>;

/**
 * A helper type to combine two event schemas together, ensuring the result is
 * as flat as possible and that we don't accidentally overwrite existing schemas
 * with a generic `string` key.
 *
 * @public
 */
export type Combine<
  TCurr extends Record<string, EventPayload>,
  TInc extends StandardEventSchemas
> = IsStringLiteral<keyof TCurr & string> extends true
  ? Simplify<
      Omit<TCurr, keyof StandardEventSchemaToPayload<TInc>> &
        StandardEventSchemaToPayload<TInc>
    >
  : StandardEventSchemaToPayload<TInc>;

/**
 * Provide an `EventSchemas` class to type events, providing type safety when
 * sending events and running functions via Inngest.
 *
 * You can provide generated Inngest types, custom types, types using Zod, or
 * a combination of the above. See {@link EventSchemas} for more information.
 *
 * @example
 *
 * ```ts
 * export const inngest = new Inngest({
 *   name: "My App",
 *   schemas: new EventSchemas().fromZod({
 *     "app/user.created": {
 *       data: z.object({
 *         id: z.string(),
 *         name: z.string(),
 *       }),
 *     },
 *   }),
 * });
 * ```
 *
 * @public
 */
export class EventSchemas<S extends Record<string, EventPayload>> {
  /**
   * TODO
   */
  public fromGenerated<T extends StandardEventSchemas>() {
    return new EventSchemas<Combine<S, T>>();
  }

  /**
   * TODO
   */
  public fromTypes<T extends StandardEventSchemas>() {
    return new EventSchemas<Combine<S, T>>();
  }

  /**
   * TODO
   */
  public fromUnion<T extends { name: string } & StandardEventSchema>() {
    return new EventSchemas<
      Combine<
        S,
        {
          [K in T["name"]]: Extract<T, { name: K }>;
        }
      >
    >();
  }

  /**
   * TODO
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public fromZod<T extends ZodEventSchemas>(schemas: T) {
    return new EventSchemas<
      Combine<
        S,
        {
          [EventName in keyof T & string]: {
            [Key in keyof T[EventName] &
              string]: T[EventName][Key] extends z.ZodTypeAny
              ? z.infer<T[EventName][Key]>
              : T[EventName][Key];
          };
        }
      >
    >();
  }
}
