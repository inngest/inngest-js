/**
 * @module
 * EXPERIMENTAL: the mark on the SDK's own tools that end the model's turn
 * (`wait`). A module of its own, so the tools and the loop can both import it
 * without importing each other.
 */

/**
 * The SDK's own tools that end the model's turn once they have run. Tools are
 * frozen, so the mark is kept beside them.
 */
const turnEnders = new WeakSet<object>();

/**
 * Marks a built-in tool as one that ends the model's turn: once it and the
 * other calls of the same reply have run, the loop ends as it does on a reply
 * with no tool call. A tool of yours with the same name replaces it.
 * Internal.
 * @param tool The tool.
 */
export const endsTurn = <T extends object>(tool: T): T => {
  turnEnders.add(tool);

  return tool;
};

/**
 * Whether a tool ends the model's turn (see `endsTurn`).
 */
export const isTurnEnder = (tool: unknown): boolean => {
  return typeof tool === "object" && tool !== null && turnEnders.has(tool);
};
