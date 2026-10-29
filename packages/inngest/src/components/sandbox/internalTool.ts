/**
 * @module
 * Marks the tools the SDK builds for itself (the `env` tool and the shim
 * tool). Only these may use options that user tools don't have, such as
 * answering inline with nothing stored.
 */
const internal = new WeakSet<object>();

export const internalTool = <T extends object>(tool: T): T => {
  internal.add(tool);

  return tool;
};

export const isInternalTool = (tool: object): boolean => {
  return internal.has(tool);
};
