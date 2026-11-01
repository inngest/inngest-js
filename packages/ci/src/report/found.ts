/**
 * What the report parsers find: a problem in a file, before it is mapped to the
 * repository and shaped into an annotation.
 *
 * @module
 */

export type FoundTool = "tsc" | "vitest" | "eslint" | "biome";

export interface Found {
  tool: FoundTool;
  /** The file as the tool printed it, which may be absolute or relative. */
  file: string;
  line: number;
  endLine?: number;
  level: "failure" | "warning" | "notice";
  /** The rule or code, which repeats group on. */
  rule?: string;
  title: string;
  message: string;
  details?: string;
}

/** The text of JSON that a tool printed among other output: from its first brace. */
export const jsonIn = (text: string): unknown => {
  const start = text.search(/[{[]/);

  if (start === -1) {
    return undefined;
  }

  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
};

/** Whether a value is a plain object. */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};
