/**
 * @module
 * EXPERIMENTAL: checks a value against the JSON Schema of an agent's card
 * `input`, so `start_agent` can refuse a call that breaks it with an error
 * the model can read. It covers `type`, `enum`, `required`, `properties` and
 * `items`; any other keyword is left to the agent's own `invoke()` trigger.
 */

import type { Json, JsonSchema } from "../json.ts";

const typeOf = (value: unknown): string => {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
};

const matchesType = (type: string, value: unknown): boolean => {
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }

  return typeOf(value) === type;
};

const isSchema = (value: Json | undefined): value is JsonSchema => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/**
 * The first way `value` breaks `schema`, written for a model to read, or
 * `undefined` when it fits.
 */
export const checkAgainstSchema = (
  schema: JsonSchema,
  value: unknown,
  path = "input",
): string | undefined => {
  if (value === undefined) {
    return `${path} is required`;
  }

  const types = ([] as Json[]).concat(schema.type ?? []);

  if (
    types.length > 0 &&
    !types.some((type) => {
      return typeof type === "string" && matchesType(type, value);
    })
  ) {
    return `${path} must be of type ${types.join(" or ")}, not ${typeOf(value)}`;
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((option) => {
      return JSON.stringify(option) === JSON.stringify(value);
    })
  ) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}`;
  }

  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;

    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === "string" && object[name] === undefined) {
        return `${path}.${name} is required`;
      }
    }

    if (isSchema(schema.properties)) {
      for (const [name, sub] of Object.entries(schema.properties)) {
        if (isSchema(sub) && object[name] !== undefined) {
          const problem = checkAgainstSchema(
            sub,
            object[name],
            `${path}.${name}`,
          );

          if (problem) {
            return problem;
          }
        }
      }
    }
  }

  if (Array.isArray(value) && isSchema(schema.items)) {
    const items = schema.items;

    for (const [index, item] of value.entries()) {
      const problem = checkAgainstSchema(items, item, `${path}[${index}]`);

      if (problem) {
        return problem;
      }
    }
  }

  return undefined;
};
