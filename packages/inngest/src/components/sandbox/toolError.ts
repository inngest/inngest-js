/**
 * @module
 * EXPERIMENTAL: The error result a tool returns instead of throwing. It lives
 * apart from `tools.ts` so modules that tools.ts imports can use it.
 */

/**
 * What `agent.toolError(body)` returns: a tool's way to give the model an
 * error result instead of a value. A tool whose `output` schema describes its
 * values may return it too; it is not checked against the schema.
 */
export interface ToolErrorResult {
  /**
   * The error body the model reads.
   */
  readonly "~error": unknown;
}

const toolErrorKey = "~error";

/**
 * Makes a tool error result. See `agent.toolError()`.
 */
export const toolErrorOf = (
  /**
   * What the model should read as the error.
   */
  body: unknown,
): ToolErrorResult => {
  return { [toolErrorKey]: body };
};

/**
 * Whether a tool returned an error result.
 */
export const isToolError = (
  /**
   * What the tool returned.
   */
  output: unknown,
): output is ToolErrorResult => {
  return (
    typeof output === "object" && output !== null && toolErrorKey in output
  );
};
