/**
 * The subset of JSON Schema the CLI's input forms read, and the best-effort
 * derivation of it from a Standard Schema, so a form can be built from
 * whichever validation library the app uses.
 *
 * @module
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

/** The keywords a form reads. Anything else in a schema is ignored. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  /** Names a `const` member of a `oneOf` or `anyOf`. */
  title?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
}

/** What a library may add to a Standard Schema to describe itself. */
type Describable = StandardSchemaV1 & {
  "~standard": {
    /** The Standard JSON Schema interface. */
    jsonSchema?: { input?: (options: { target: string }) => unknown };
  };
  /** Zod. */
  toJSONSchema?: () => unknown;
  /** ArkType. */
  toJsonSchema?: () => unknown;
};

/**
 * The JSON Schema of what `schema` accepts, or `undefined` when the library
 * can't say. Tries the Standard JSON Schema interface, then `toJSONSchema()`
 * (Zod), then `toJsonSchema()` (ArkType).
 */
export const jsonSchemaOf = (
  schema: StandardSchemaV1 | undefined,
): JsonSchema | undefined => {
  const describable = schema as Describable | undefined;

  if (!describable) {
    return undefined;
  }

  const derivations = [
    () => {
      return describable["~standard"].jsonSchema?.input?.({
        target: "draft-2020-12",
      });
    },
    () => {
      return describable.toJSONSchema?.();
    },
    () => {
      return describable.toJsonSchema?.();
    },
  ];

  for (const derive of derivations) {
    try {
      const derived = derive();

      if (derived && typeof derived === "object" && !Array.isArray(derived)) {
        return derived as JsonSchema;
      }
    } catch {
      // A schema that can't be written as JSON Schema throws; try the next way.
    }
  }

  return undefined;
};
