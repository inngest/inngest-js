import { Middleware } from "inngest";
import SuperJSON from "superjson";
import type { SuperJSONResult } from "superjson";
import { BaseSerializerMiddleware, isRecord } from "./base-serializer";

const MARKER = "__inngestSuperJson" as const;

/**
 * The envelope format wrapping a superjson-serialized value. The entire value
 * is serialized by superjson into `json` + `meta`, then wrapped in this
 * envelope before being sent to the Inngest server.
 */
export type SerializedValue = {
  [MARKER]: true;
  json: SuperJSONResult["json"];
  meta?: SuperJSONResult["meta"];
};

// biome-ignore lint/suspicious/noExplicitAny: required for function type matching
type NotSerializable = ((...args: any[]) => any) | symbol;

/**
 * Recursively preserves types that superjson handles through Inngest's
 * serialization pipeline. superjson supports Date, RegExp, BigInt, Map, Set,
 * URL, Error, undefined, typed arrays, NaN, Infinity, and -0 out of the box.
 *
 * Functions and symbols (unless registered) are stripped, matching superjson's
 * runtime behavior.
 *
 * @example
 * ```ts
 * type MyData = Preserved<{
 *   createdAt: Date;
 *   tags: Set<string>;
 *   config: Map<string, number>;
 *   name: string;
 * }>;
 * // { createdAt: Date; tags: Set<string>; config: Map<string, number>; name: string }
 * ```
 */
export type Preserved<T> = T extends NotSerializable
  ? never
  : T extends Map<infer K, infer V>
    ? Map<Preserved<K>, Preserved<V>>
    : T extends Set<infer V>
      ? Set<Preserved<V>>
      : T extends (infer U)[]
        ? Preserved<U>[]
        : T extends readonly (infer U)[]
          ? readonly Preserved<U>[]
          : T extends Record<string, unknown>
            ? { [K in keyof T]: Preserved<T[K]> }
            : T;

/**
 * Static type transform that preserves superjson-supported types through
 * Inngest's serialization pipeline.
 */
export interface SuperJsonTransform extends Middleware.StaticTransform {
  Out: Preserved<this["In"]>;
}

/**
 * Options for creating a configured {@link SuperJsonMiddleware} via the
 * {@link superJsonMiddleware} factory function.
 */
export interface SuperJsonMiddlewareOptions {
  /**
   * A pre-configured SuperJSON instance. Use this to register custom types
   * via `instance.registerCustom()` or `instance.registerClass()` before
   * passing it to the middleware.
   *
   * If not provided, a fresh SuperJSON instance is created with default
   * settings (handles Date, RegExp, BigInt, Map, Set, URL, Error, etc.).
   */
  instance?: SuperJSON;

  /**
   * Enable referential equality deduplication in superjson. When `true`,
   * objects referenced multiple times are stored once with back-references,
   * preserving `===` relationships after deserialization.
   *
   * Only used when `instance` is not provided. Defaults to `false`.
   */
  dedupe?: boolean;
}

/**
 * Middleware that uses superjson to preserve non-JSON types through Inngest's
 * data pipeline. Handles Date, RegExp, BigInt, Map, Set, URL, Error,
 * undefined, typed arrays, NaN, Infinity, and -0 out of the box.
 *
 * Custom types can be registered via the SuperJSON instance.
 *
 * @example Direct usage with defaults:
 * ```ts
 * import { Inngest } from "inngest";
 * import { SuperJsonMiddleware } from "@inngest/middleware-super-json";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   middleware: [SuperJsonMiddleware],
 * });
 * ```
 *
 * @example With custom types via subclass:
 * ```ts
 * import SuperJSON from "superjson";
 *
 * const sj = new SuperJSON();
 * sj.registerCustom<Decimal, string>(
 *   {
 *     isApplicable: (v): v is Decimal => Decimal.isDecimal(v),
 *     serialize: (v) => v.toJSON(),
 *     deserialize: (v) => new Decimal(v),
 *   },
 *   "decimal.js",
 * );
 *
 * class MySuperJson extends SuperJsonMiddleware {
 *   protected override sj = sj;
 * }
 * ```
 */
export class SuperJsonMiddleware extends BaseSerializerMiddleware<SerializedValue> {
  readonly id = "@inngest/middleware-super-json";

  declare functionOutputTransform: SuperJsonTransform;
  declare stepOutputTransform: SuperJsonTransform;

  protected override readonly recursive = false;

  /** The SuperJSON instance used for serialization. */
  protected sj: SuperJSON = new SuperJSON();

  protected needsSerialize(value: unknown): boolean {
    return value !== null && value !== undefined;
  }

  protected serialize(value: unknown): SerializedValue {
    const { json, meta } = this.sj.serialize(value);
    return { [MARKER]: true, json, meta };
  }

  protected isSerialized(value: unknown): value is SerializedValue {
    if (!isRecord(value)) {
      return false;
    }

    return value[MARKER] === true && "json" in value;
  }

  protected deserialize(value: SerializedValue): unknown {
    return this.sj.deserialize({ json: value.json, meta: value.meta });
  }
}

/**
 * Factory function to create a configured SuperJsonMiddleware class.
 * Use this when you need a custom SuperJSON instance (e.g. for registering
 * custom types) without subclassing.
 *
 * @example
 * ```ts
 * import SuperJSON from "superjson";
 * import { superJsonMiddleware } from "@inngest/middleware-super-json";
 *
 * const sj = new SuperJSON();
 * sj.registerCustom<Decimal, string>(
 *   {
 *     isApplicable: (v): v is Decimal => Decimal.isDecimal(v),
 *     serialize: (v) => v.toJSON(),
 *     deserialize: (v) => new Decimal(v),
 *   },
 *   "decimal.js",
 * );
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   middleware: [superJsonMiddleware({ instance: sj })],
 * });
 * ```
 */
export const superJsonMiddleware = (
  opts?: SuperJsonMiddlewareOptions,
): Middleware.Class => {
  const instance =
    opts?.instance ?? new SuperJSON({ dedupe: opts?.dedupe ?? false });

  class ConfiguredSuperJsonMiddleware extends SuperJsonMiddleware {
    protected override sj = instance;
  }

  return ConfiguredSuperJsonMiddleware;
};
