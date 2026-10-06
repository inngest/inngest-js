/**
 * What an input form asks and how it reads the answers, worked out from a JSON
 * Schema: the fields in order, the kind of prompt each one gets, and the
 * checks on what is typed. Pure; `form.ts` holds the state and `formView.ts`
 * draws it.
 *
 * Checks only reject what the schema surely forbids. Anything the form can't
 * read from the schema (a union of objects, a pattern) passes here and is left
 * to the job's own validation.
 *
 * @module
 */

import type { JsonSchema } from "../../local/jsonSchema.ts";

/**
 * How a field is asked: a line of text, a number, one of a few options, a
 * list of lines, or (for what doesn't fit those) a line of JSON.
 */
export type FieldKind = "text" | "number" | "choice" | "list" | "json";

export interface Option {
  label: string;
  value: unknown;
}

export interface Field {
  /** Where the answer goes in the value, like `["build", "target"]`. Empty for a schema that isn't an object. */
  path: string[];
  schema: JsonSchema;
  kind: FieldKind;
  /** Whether it must be answered: it and every object around it is required. */
  required: boolean;
  /** For a choice, what to pick from. */
  options: Option[];
}

/** What is wrong with a value, and where. */
export interface Problem {
  path: string[];
  message: string;
}

/** What reading a typed answer gives: the value, or why it was refused. */
export type Reading = { value: unknown } | { error: string };

const isPrimitive = (value: unknown): boolean => {
  return ["string", "number", "boolean"].includes(typeof value);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/** The options a schema offers when it lists its values, or `[]`. */
const optionsOf = (schema: JsonSchema): Option[] => {
  if (schema.enum?.every(isPrimitive)) {
    return schema.enum.map((value) => {
      return { label: String(value), value };
    });
  }

  if (isPrimitive(schema.const)) {
    return [{ label: String(schema.const), value: schema.const }];
  }

  const members = schema.oneOf ?? schema.anyOf ?? [];

  if (
    members.length > 0 &&
    members.every((member) => {
      return isPrimitive(member.const);
    })
  ) {
    return members.map((member) => {
      return {
        label: member.title ?? String(member.const),
        value: member.const,
      };
    });
  }

  if (schema.type === "boolean") {
    return [
      { label: "yes", value: true },
      { label: "no", value: false },
    ];
  }

  return [];
};

export const kindOf = (schema: JsonSchema): FieldKind => {
  if (optionsOf(schema).length > 0) {
    return "choice";
  }

  if (schema.type === "string") {
    return "text";
  }

  if (schema.type === "number" || schema.type === "integer") {
    return "number";
  }

  if (schema.type === "array" && schema.items) {
    const item = kindOf(schema.items);

    return item === "text" || item === "number" ? "list" : "json";
  }

  return "json";
};

const walk = (
  schema: JsonSchema,
  path: string[],
  required: boolean,
): Field[] => {
  const properties = Object.entries(schema.properties ?? {});

  if (properties.length === 0) {
    return [
      {
        path,
        schema,
        kind: kindOf(schema),
        required,
        options: optionsOf(schema),
      },
    ];
  }

  return properties.flatMap(([key, child]) => {
    return walk(
      child,
      [...path, key],
      required && (schema.required ?? []).includes(key),
    );
  });
};

/**
 * The fields a schema is asked as, in order. An object is asked property by
 * property, nested objects included.
 */
export const fieldsOf = (schema: JsonSchema): Field[] => {
  return walk(schema, [], true);
};

/** Identifies a field in a form's answers. */
export const fieldKey = (field: Field): string => {
  return field.path.join(".");
};

/** What a field is called: its path, or `value` when it is the whole input. */
export const fieldName = (field: Field): string => {
  return fieldKey(field) || "value";
};

/** The value at `path` of `value`, if there is one. */
export const valueAt = (value: unknown, path: string[]): unknown => {
  return path.reduce<unknown>((inner, key) => {
    return isRecord(inner) ? inner[key] : undefined;
  }, value);
};

/** A value to start from: the schema's default, else something of its shape. */
export const exampleOf = (schema: JsonSchema): unknown => {
  if (schema.default !== undefined) {
    return schema.default;
  }

  const [first] = optionsOf(schema);

  if (first) {
    return first.value;
  }

  switch (schema.type) {
    case "string": {
      return "";
    }

    case "number":
    case "integer": {
      return schema.minimum ?? 0;
    }

    case "boolean": {
      return false;
    }

    case "array": {
      return [];
    }

    case "object": {
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, child]) => {
          return [key, exampleOf(child)];
        }),
      );
    }

    default: {
      const [member] = schema.oneOf ?? schema.anyOf ?? [];

      return member ? exampleOf(member) : undefined;
    }
  }
};

/** How a field's type reads in a hint: `string`, `integer, 1 to 10`, `list of string`. */
export const typeLabel = (field: Field): string => {
  const { schema } = field;

  switch (field.kind) {
    case "choice": {
      return schema.type === "boolean"
        ? "yes or no"
        : field.options
            .map((option) => {
              return option.label;
            })
            .join(" | ");
    }

    case "text": {
      return "string";
    }

    case "number": {
      const { minimum, maximum } = schema;
      const range =
        minimum !== undefined && maximum !== undefined
          ? `, ${minimum} to ${maximum}`
          : [
              minimum === undefined ? "" : `, at least ${minimum}`,
              maximum === undefined ? "" : `, at most ${maximum}`,
            ].join("");

      return `${schema.type === "integer" ? "integer" : "number"}${range}`;
    }

    case "list": {
      return `list of ${schema.items?.type === "string" ? "strings" : "numbers"}`;
    }

    case "json": {
      return "JSON";
    }
  }
};

/** The fields a schema asks for and their types, on one line, for an error. */
export const describeFields = (schema: JsonSchema): string => {
  return fieldsOf(schema)
    .map((field) => {
      const type = typeLabel(field);

      return `${fieldName(field)} (${field.required ? type : `${type}, optional`})`;
    })
    .join(", ");
};

/**
 * What is surely wrong with `value` under `schema`. A problem is a type that
 * doesn't match, a value outside a list of values, a number out of range or a
 * missing required property.
 */
export const problemsOf = (
  schema: JsonSchema,
  value: unknown,
  path: string[] = [],
): Problem[] => {
  const problem = (message: string): Problem[] => {
    return [{ path, message }];
  };
  const options = optionsOf(schema);

  if (
    schema.type !== "boolean" &&
    options.length > 0 &&
    !options.some((option) => {
      return option.value === value;
    })
  ) {
    return problem(
      `Must be one of ${options
        .map((option) => {
          return option.label;
        })
        .join(", ")}.`,
    );
  }

  switch (schema.type) {
    case "string": {
      return typeof value === "string" ? [] : problem("Must be a string.");
    }

    case "boolean": {
      return typeof value === "boolean"
        ? []
        : problem("Must be true or false.");
    }

    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return problem("Must be a number.");
      }

      if (schema.type === "integer" && !Number.isInteger(value)) {
        return problem("Must be a whole number.");
      }

      if (schema.minimum !== undefined && value < schema.minimum) {
        return problem(`Must be at least ${schema.minimum}.`);
      }

      if (schema.maximum !== undefined && value > schema.maximum) {
        return problem(`Must be at most ${schema.maximum}.`);
      }

      return [];
    }

    case "array": {
      if (!Array.isArray(value)) {
        return problem("Must be a list.");
      }

      const items = schema.items;

      return items
        ? value.flatMap((item, index) => {
            return problemsOf(items, item, [...path, String(index)]);
          })
        : [];
    }

    case "object": {
      if (!isRecord(value)) {
        return problem("Must be an object.");
      }

      return [
        ...(schema.required ?? [])
          .filter((key) => {
            return value[key] === undefined;
          })
          .map((key): Problem => {
            return { path: [...path, key], message: "Required." };
          }),
        ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
          return value[key] === undefined
            ? []
            : problemsOf(child, value[key], [...path, key]);
        }),
      ];
    }

    default: {
      return [];
    }
  }
};

/** A problem as a line: `target: Must be one of web, api.` */
export const describeProblem = (problem: Problem): string => {
  return problem.path.length > 0
    ? `${problem.path.join(".")}: ${problem.message}`
    : problem.message;
};

/**
 * Read what was typed for a field of `kind`, which holds a value of `schema`.
 * A text answer is taken as typed; a number or JSON one is parsed first.
 */
export const readAnswer = (
  kind: FieldKind,
  schema: JsonSchema,
  text: string,
): Reading => {
  let value: unknown = text;

  if (kind === "number") {
    value = Number(text);

    if (text.trim() === "" || Number.isNaN(value)) {
      return { error: "Enter a number." };
    }
  }

  if (kind === "json") {
    try {
      value = JSON.parse(text);
    } catch {
      return { error: "Not valid JSON." };
    }
  }

  const [problem] = problemsOf(schema, value);

  return problem ? { error: describeProblem(problem) } : { value };
};

/**
 * Build the value from the answers, which are keyed by {@link fieldKey}. A
 * field left out is left out, and so is an optional object nothing was
 * answered in.
 */
export const assemble = (
  schema: JsonSchema,
  answers: Record<string, unknown>,
): unknown => {
  const build = (
    node: JsonSchema,
    path: string[],
    required: boolean,
  ): { present: boolean; value?: unknown } => {
    const properties = Object.entries(node.properties ?? {});

    if (properties.length === 0) {
      const key = path.join(".");

      return key in answers
        ? { present: true, value: answers[key] }
        : { present: false };
    }

    const value: Record<string, unknown> = {};

    for (const [key, child] of properties) {
      const built = build(
        child,
        [...path, key],
        required && (node.required ?? []).includes(key),
      );

      if (built.present) {
        value[key] = built.value;
      }
    }

    return { present: required || Object.keys(value).length > 0, value };
  };

  return build(schema, [], true).value;
};

/** Every problem with a finished `value`, as lines, for an error. */
export const describeProblems = (
  schema: JsonSchema,
  value: unknown,
): string[] => {
  return problemsOf(schema, value).map(describeProblem);
};
