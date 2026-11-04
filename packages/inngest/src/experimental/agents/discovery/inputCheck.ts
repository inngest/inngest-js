/**
 * @module
 * EXPERIMENTAL: checks a value against a JSON Schema, so `start_agent` can
 * refuse a call that breaks an agent's card `input` with an error the model
 * can read, and a report's data can be held to the report's own schema.
 *
 * It covers `type`, `enum`, `const`, `required`, `properties`,
 * `additionalProperties`, `items`, `minItems`, `maxItems`, `minimum`,
 * `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`,
 * `minLength`, `maxLength`, `pattern`, `anyOf`, `oneOf`, `allOf`, `not` and
 * local `$ref`s (`#/...`). A keyword it does not know is not checked.
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
 * Whether two JSON values are equal, whatever the order of an object's keys.
 */
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item, index) => {
        return same(item, b[index]);
      })
    );
  }

  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = Object.keys(a);
    const right = Object.keys(b);

    return (
      left.length === right.length &&
      left.every((key) => {
        return (
          key in b &&
          same(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
          )
        );
      })
    );
  }

  return a === b;
};

/**
 * The schema a local `$ref` (`#/a/b`) points at, or `undefined`.
 */
const resolveRef = (root: JsonSchema, ref: string): JsonSchema | undefined => {
  if (ref === "#") {
    return root;
  }

  if (!ref.startsWith("#/")) {
    return undefined;
  }

  let at: unknown = root;

  for (const part of ref.slice(2).split("/")) {
    if (typeof at !== "object" || at === null) {
      return undefined;
    }

    at = (at as Record<string, unknown>)[
      decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~")
    ];
  }

  return isSchema(at as Json) ? (at as JsonSchema) : undefined;
};

const check = (
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  path: string,
  depth: number,
): string | undefined => {
  if (value === undefined) {
    return `${path} is required`;
  }

  // A schema that nests this deep is cyclic or hostile.
  if (depth > 64) {
    return `${path} is nested too deeply to check`;
  }

  const next = depth + 1;

  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref);

    if (target) {
      const problem = check(root, target, value, path, next);

      if (problem) {
        return problem;
      }
    }
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
      return same(option, value);
    })
  ) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}`;
  }

  if ("const" in schema && !same(schema.const, value)) {
    return `${path} must be ${JSON.stringify(schema.const)}`;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `${path} must be at least ${schema.minimum}`;
    }

    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `${path} must be at most ${schema.maximum}`;
    }

    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      return `${path} must be greater than ${schema.exclusiveMinimum}`;
    }

    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      return `${path} must be less than ${schema.exclusiveMaximum}`;
    }

    if (
      typeof schema.multipleOf === "number" &&
      schema.multipleOf > 0 &&
      !Number.isInteger(value / schema.multipleOf)
    ) {
      return `${path} must be a multiple of ${schema.multipleOf}`;
    }
  }

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      return `${path} must be at least ${schema.minLength} characters`;
    }

    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      return `${path} must be at most ${schema.maxLength} characters`;
    }

    if (typeof schema.pattern === "string") {
      let pattern: RegExp | undefined;

      try {
        pattern = new RegExp(schema.pattern, "u");
      } catch {
        // A pattern this runtime cannot read is not checked.
      }

      if (pattern && !pattern.test(value)) {
        return `${path} must match the pattern ${schema.pattern}`;
      }
    }
  }

  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;

    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === "string" && object[name] === undefined) {
        return `${path}.${name} is required`;
      }
    }

    const properties = isSchema(schema.properties) ? schema.properties : {};

    for (const [name, sub] of Object.entries(properties)) {
      if (isSchema(sub) && object[name] !== undefined) {
        const problem = check(root, sub, object[name], `${path}.${name}`, next);

        if (problem) {
          return problem;
        }
      }
    }

    if (schema.additionalProperties !== undefined) {
      for (const name of Object.keys(object)) {
        if (name in properties || object[name] === undefined) {
          continue;
        }

        if (schema.additionalProperties === false) {
          return `${path}.${name} is not allowed`;
        }

        if (isSchema(schema.additionalProperties)) {
          const problem = check(
            root,
            schema.additionalProperties,
            object[name],
            `${path}.${name}`,
            next,
          );

          if (problem) {
            return problem;
          }
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `${path} must have at least ${schema.minItems} items`;
    }

    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `${path} must have at most ${schema.maxItems} items`;
    }

    if (isSchema(schema.items)) {
      const items = schema.items;

      for (const [index, item] of value.entries()) {
        const problem = check(root, items, item, `${path}[${index}]`, next);

        if (problem) {
          return problem;
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      if (isSchema(sub)) {
        const problem = check(root, sub, value, path, next);

        if (problem) {
          return problem;
        }
      }
    }
  }

  const passes = (list: Json[]): number => {
    return list.filter((sub) => {
      return isSchema(sub) && check(root, sub, value, path, next) === undefined;
    }).length;
  };

  if (Array.isArray(schema.anyOf) && passes(schema.anyOf) === 0) {
    return `${path} must fit one of the allowed shapes`;
  }

  if (Array.isArray(schema.oneOf) && passes(schema.oneOf) !== 1) {
    return `${path} must fit exactly one of the allowed shapes`;
  }

  if (
    isSchema(schema.not) &&
    check(root, schema.not, value, path, next) === undefined
  ) {
    return `${path} must not fit the forbidden shape`;
  }

  return undefined;
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
  return check(schema, schema, value, path, 0);
};
