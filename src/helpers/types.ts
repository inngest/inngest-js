import { EventPayload } from "../types";

/**
 * Returns a union of all of the values in a given object, regardless of key.
 */
export type ValueOf<T> = T extends Record<string, any>
  ? {
      [K in keyof T]: T[K];
    }[keyof T]
  : never;

/**
 * Returns the given generic as either itself or an array of itself.
 */
export type SingleOrArray<T> = T | T[];

/**
 * Acts like `Partial<T>` but only for the keys in `K`, leaving the rest alone.
 */
export type PartialK<T, K extends PropertyKey = PropertyKey> = Partial<
  Pick<T, Extract<keyof T, K>>
> &
  Omit<T, K> extends infer O
  ? { [P in keyof O]: O[P] }
  : never;

/**
 * A payload that could be sent to Inngest, based on the given `Events`.
 */
export type SendEventPayload<Events extends Record<string, EventPayload>> =
  SingleOrArray<
    {
      [K in keyof Events]: PartialK<Omit<Events[K], "v">, "ts">;
    }[keyof Events]
  >;

/**
 * Retrieve an event's name based on the given payload. Defaults to `string`.
 */
export type EventName<Event extends EventPayload> = Event extends EventPayload
  ? Event["name"]
  : string;
