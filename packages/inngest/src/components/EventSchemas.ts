import { type Simplify } from "type-fest";
import {
  type FnFailedEventName,
  type FnFinishedEventName,
  type FnInvokedEventName,
} from "../helpers/consts";
import { type IsEmptyObject, type IsStringLiteral } from "../helpers/types";
import type * as z from "../helpers/validators/zod";
import {
  type EventPayload,
  type FailureEventPayload,
  type FinishedEventPayload,
  type InvokedEventPayload,
} from "../types";

/**
 * Declares the shape of an event schema we expect from the user. This may be
 * different to what a user is sending us depending on the supported library,
 * but this standard format is what we require as the end result.
 *
 * @internal
 */
export type StandardEventSchema = {
  name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
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
 * A string error used to highlight to a user that they have a clashing name
 * between the event name and the key of the event schema.
 */
type ClashingNameError =
  "Error: Omit 'name' from event schemas or make sure it matches the key.";

/**
 * Given a type T, check if any of the keys in T are a clashing name. If they
 * are, return the error type, otherwise return the original type.
 */
type CheckNever<T> = ClashingNameError extends T[keyof T]
  ? IsEmptyObject<T[keyof T]> extends true
    ? T
    : ClashingNameError
  : T;

/**
 * Given a type T, check if any of the keys in T are a clashing name. If they
 * are, return the error type for that key, otherwise return the original type.
 */
type PreventClashingNames<T> = CheckNever<{
  [K in keyof T]: T[K] extends { name: infer N }
    ? N extends K
      ? T[K]
      : ClashingNameError
    : T[K];
}>;

/**
 * A literal Zod schema, which is a Zod schema that has a literal string as the
 * event name. This can be used to create correct Zod schemas outside of the
 * `EventSchemas` class.
 *
 * @public
 */
export type LiteralZodEventSchema = z.ZodObject<{
  name: z.ZodLiteral<string>;
  data?: z.ValidZodValue;
  user?: z.ValidZodValue;
}>;

/**
 * An array of literal zod event schemas.
 *
 * @public
 */
export type LiteralZodEventSchemas = LiteralZodEventSchema[];

/**
 * A helper type that declares a standardised custom part of the event schema,
 * defined using Zod.
 *
 * @public
 */
export type ZodEventSchemas = Record<
  string,
  {
    data?: z.ValidZodValue;
    user?: z.ValidZodValue;
  }
>;

/**
 * A helper type that takes a union of Zod schemas and extracts the literal
 * matching event from the given schemas. Required when picking out types from
 * a union that require inference to work.
 *
 * @public
 */
export type PickLiterals<T> = {
  [K in keyof T]: Extract<T[K], { name: z.ZodLiteral<K> }>;
};

/**
 * A helper type to extract the name from a given literal Zod schema.
 *
 * @public
 */
export type GetName<T> = T extends z.ZodObject<infer U>
  ? U extends { name: z.ZodLiteral<infer S extends string> }
    ? S
    : never
  : never;

/**
 * Given an input T, infer the shape of the Zod schema if that input is a Zod
 * object.
 *
 * @public
 */
export type InferZodShape<T> = T extends z.AnyZodObject ? T["shape"] : never;

/**
 * Given a set of literal Zod schemas, convert them into a record of Zod schemas
 * with the literal name as the key.
 *
 * @public
 */
export type LiteralToRecordZodSchemas<T> = PickLiterals<
  T extends LiteralZodEventSchemas
    ? {
        [I in keyof T as GetName<T[I]>]: InferZodShape<T[I]>;
      }
    : T extends ZodEventSchemas
      ? T
      : never
>;

/**
 * Given a set of Zod schemas in a record format, convert them into a standard
 * event schema format.
 *
 * @public
 */
export type ZodToStandardSchema<T extends ZodEventSchemas> = {
  [EventName in keyof T & string]: {
    [Key in keyof T[EventName] & string]: T[EventName][Key] extends z.ZodTypeAny
      ? z.infer<T[EventName][Key]>
      : T[EventName][Key];
  };
};

/**
 * A helper type to convert input schemas into the format expected by the
 * `EventSchemas` class, which ensures that each event contains all pieces
 * of information required.
 *
 * It purposefully uses slightly more complex (read: verbose) mapped types to
 * flatten the output and preserve comments.
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
  TInc extends StandardEventSchemas,
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
 *   id: "my-app",
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
export class EventSchemas<
  S extends Record<string, EventPayload> = {
    [FnFailedEventName]: FailureEventPayload;
    [FnFinishedEventName]: FinishedEventPayload;
    [FnInvokedEventName]: InvokedEventPayload;
  },
> {
  /**
   * Use generated Inngest types to type events.
   */
  public fromGenerated<T extends StandardEventSchemas>() {
    return new EventSchemas<Combine<S, T>>();
  }

  /**
   * Use a `Record<>` type to type events.
   *
   * @example
   *
   * ```ts
   * export const inngest = new Inngest({
   *   id: "my-app",
   *   schemas: new EventSchemas().fromRecord<{
   *     "app/user.created": {
   *       data: {
   *         id: string;
   *         name: string;
   *       };
   *     };
   *   }>(),
   * });
   * ```
   */
  public fromRecord<T extends StandardEventSchemas>(
    ..._args: PreventClashingNames<T> extends ClashingNameError
      ? [ClashingNameError]
      : []
  ) {
    return new EventSchemas<Combine<S, T>>();
  }

  /**
   * Use a union type to type events.
   *
   * @example
   *
   * ```ts
   * type AccountCreated = {
   *   name: "app/account.created";
   *   data: { org: string };
   *   user: { id: string };
   * };
   *
   * type AccountDeleted = {
   *   name: "app/account.deleted";
   *   data: { org: string };
   *   user: { id: string };
   * };
   *
   * type Events = AccountCreated | AccountDeleted;
   *
   * export const inngest = new Inngest({
   *   id: "my-app",
   *   schemas: new EventSchemas().fromUnion<Events>(),
   * });
   * ```
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
   * Use Zod to type events.
   *
   * @example
   *
   * ```ts
   * export const inngest = new Inngest({
   *   id: "my-app",
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
   */
  public fromZod<T extends ZodEventSchemas | LiteralZodEventSchemas>(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    schemas: T
  ) {
    return new EventSchemas<
      Combine<
        S,
        ZodToStandardSchema<
          T extends ZodEventSchemas ? T : LiteralToRecordZodSchemas<T>
        >
      >
    >();
  }
}
