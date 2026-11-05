/**
 * @module
 * EXPERIMENTAL: what a model reads about a tool. A tool's `description` is a
 * string, used as it is, or an object whose parts render into one paragraph
 * in a fixed order: what the tool does, when to use it, when not to. A tool
 * with an `output` schema also gets a `Returns:` line made from that schema,
 * so what the model is told about the result is what the code returns.
 *
 * The object's `context` is not part of the description: it is a fact about
 * what having the tool means for the agent, and the agent's briefing lists it
 * under "From your tools" for agents that have the tool in that run.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as z4 from "zod/v4";

/**
 * EXPERIMENTAL: A tool's description in parts. The parts render in this
 * order, as one paragraph, so every tool reads the same way.
 *
 * @example
 * ```ts
 * const chat = tool({
 *   description: {
 *     does: "Sends a message to the person you are talking with.",
 *     use: "for anything the person should read",
 *     avoid: "for notes to yourself",
 *     context:
 *       "Only messages sent with `chat` reach the person; anything else you write is private.",
 *   },
 *   input: z.object({ text: z.string() }),
 *   run: async ({ text }) => { ... },
 * });
 * ```
 */
export interface ToolDescriptionParts {
  /**
   * What the tool does, in a sentence or two.
   */
  does: string;

  /**
   * When to use it. A clause such as `"to hand off work"` or `"when you need
   * an answer"` reads as "Use it to hand off work."; a whole sentence that
   * starts with "Use" or "Only" is kept as written.
   */
  use?: string;

  /**
   * When not to use it, naming the tempting misuse. A clause such as
   * `"to ask for status"` reads as "Don't use it to ask for status."; a
   * whole sentence that starts with "Don't", "Do not", "Never" or "Avoid" is
   * kept as written.
   */
  avoid?: string;

  /**
   * A fixed fact about what having this tool means for the agent, such as
   * "Only messages sent with `chat` reach the person; anything else you write
   * is private". It is not part of the tool's description: the SDK puts it
   * in the briefing of each agent that has the tool in a run, under "From
   * your tools".
   */
  context?: string;
}

/**
 * EXPERIMENTAL: What a tool's `description` takes: a string, used as it is,
 * or the parts of one (see `ToolDescriptionParts`).
 */
export type ToolDescription = string | ToolDescriptionParts;

const sentence = (text: string): string => {
  const trimmed = text.trim();

  if (trimmed === "") {
    return "";
  }

  const capital = trimmed[0]?.toUpperCase() + trimmed.slice(1);

  return /[.!?:)`"]$/.test(capital) ? capital : `${capital}.`;
};

const clause = (text: string, lead: string, kept: RegExp): string => {
  const trimmed = text.trim();

  if (trimmed === "") {
    return "";
  }

  return sentence(kept.test(trimmed) ? trimmed : `${lead} ${trimmed}`);
};

const keptUse = /^(use|only)\b/i;
const keptAvoid = /^(don't|do not|never|avoid)\b/i;

/**
 * EXPERIMENTAL: The text of a description without its `Returns:` line: a
 * string as it is, or the parts in order.
 * @param description The tool's `description`.
 */
export const toolDescriptionText = (
  description: ToolDescription | undefined,
): string | undefined => {
  if (description === undefined || typeof description === "string") {
    return description;
  }

  return [
    sentence(description.does),
    description.use === undefined
      ? ""
      : clause(description.use, "Use it", keptUse),
    description.avoid === undefined
      ? ""
      : clause(description.avoid, "Don't use it", keptAvoid),
  ]
    .filter(Boolean)
    .join(" ");
};

/**
 * EXPERIMENTAL: The `context` of a description, if it has one.
 * @param description The tool's `description`.
 */
export const toolContextOf = (description: unknown): string | undefined => {
  if (typeof description !== "object" || description === null) {
    return undefined;
  }

  const context = (description as { context?: unknown }).context;

  return typeof context === "string" && context.trim() !== ""
    ? sentence(context)
    : undefined;
};

/**
 * A description with `note` added after what the tool does, keeping its
 * other parts (and its `context`).
 */
export const withNote = (
  description: ToolDescription | undefined,
  note: string,
): ToolDescription | undefined => {
  if (!note) {
    return description;
  }

  if (description === undefined || typeof description === "string") {
    return [description, note].filter(Boolean).join(" ");
  }

  return { ...description, does: `${sentence(description.does)} ${note}` };
};

type JsonSchemaProvider = {
  jsonSchema?: {
    output: (options: { target: string }) => Record<string, unknown>;
  };
};

/**
 * The JSON Schema of what a schema gives back, or `undefined` when the
 * library can't say.
 */
const outputJsonSchema = (
  schema: StandardSchemaV1,
): Record<string, unknown> | undefined => {
  try {
    const provider = schema["~standard"] as JsonSchemaProvider;

    if (provider.jsonSchema?.output) {
      return provider.jsonSchema.output({ target: "draft-2020-12" });
    }

    if ("_zod" in schema) {
      return z4.toJSONSchema(schema as unknown as z4.ZodType, {
        io: "output",
        unrepresentable: "any",
      }) as Record<string, unknown>;
    }
  } catch {
    // A schema that can't be shown is still checked; it is just not described.
  }

  return undefined;
};

const maxShapeDepth = 5;
const propertyName = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A JSON Schema as a short TypeScript-like type, such as
 * `{ thread: string, ok?: true }`.
 */
export const shapeOf = (schema: unknown, depth = 0): string => {
  if (schema === true || schema === undefined) {
    return "any";
  }

  if (typeof schema !== "object" || schema === null) {
    return "any";
  }

  const node = schema as {
    type?: unknown;
    const?: unknown;
    enum?: unknown[];
    items?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: unknown;
  };

  if ("const" in node) {
    return JSON.stringify(node.const);
  }

  if (Array.isArray(node.enum)) {
    return node.enum
      .map((value) => {
        return JSON.stringify(value);
      })
      .join(" | ");
  }

  const union = node.anyOf ?? node.oneOf;

  if (Array.isArray(union)) {
    return union
      .map((member) => {
        return shapeOf(member, depth);
      })
      .join(" | ");
  }

  if (Array.isArray(node.type)) {
    return node.type
      .map((type) => {
        return shapeOf({ ...node, type }, depth);
      })
      .join(" | ");
  }

  if (node.type === "array") {
    const item = shapeOf(node.items, depth + 1);
    const items = (node.items ?? {}) as Record<string, unknown>;
    const union =
      Array.isArray(items.anyOf) ||
      Array.isArray(items.oneOf) ||
      Array.isArray(items.type) ||
      (Array.isArray(items.enum) && items.enum.length > 1);

    return union ? `(${item})[]` : `${item}[]`;
  }

  if (node.type === "integer") {
    return "number";
  }

  if (node.type === "object" || node.properties) {
    if (depth >= maxShapeDepth) {
      return "object";
    }

    const entries = Object.entries(node.properties ?? {});

    if (entries.length === 0) {
      return node.additionalProperties &&
        typeof node.additionalProperties === "object"
        ? `Record<string, ${shapeOf(node.additionalProperties, depth + 1)}>`
        : "object";
    }

    const required = new Set(node.required ?? []);
    const fields = entries.map(([key, value]) => {
      const name = propertyName.test(key) ? key : JSON.stringify(key);

      return `${name}${required.has(key) ? "" : "?"}: ${shapeOf(value, depth + 1)}`;
    });

    return `{ ${fields.join(", ")} }`;
  }

  return typeof node.type === "string" ? node.type : "any";
};

/**
 * EXPERIMENTAL: The short type of what a tool with `output` returns, made
 * from the schema, or `undefined` when the schema can't be shown.
 * @param output The tool's `output` schema.
 */
export const returnsShape = (
  output: StandardSchemaV1 | undefined,
): string | undefined => {
  if (!output) {
    return undefined;
  }

  const json = outputJsonSchema(output);

  return json === undefined ? undefined : shapeOf(json);
};

/**
 * EXPERIMENTAL: What a model reads about a tool: the text of its
 * `description`, then `Returns: <shape>` when it has an `output` schema.
 * The description's `context` is not in it (the briefing carries it).
 * @param description The tool's `description`.
 * @param output The tool's `output` schema.
 */
export const renderToolDescription = (
  description: ToolDescription | undefined,
  output?: StandardSchemaV1,
): string | undefined => {
  const text = toolDescriptionText(description);
  const shape = returnsShape(output);

  if (shape === undefined) {
    return text;
  }

  return [text && sentence(text), `Returns: ${shape}`]
    .filter(Boolean)
    .join(" ");
};
