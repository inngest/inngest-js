/**
 * @module
 * The text of an inbox message, for scenarios that send plain messages.
 */

/**
 * The `data.text` of an inbox message (an `agent/message` or `agent/steer`),
 * or `undefined`.
 */
export const textOf = (
  message: { data: unknown } | null | undefined,
): string | undefined => {
  const text = (message?.data as { text?: unknown } | undefined)?.text;

  return typeof text === "string" ? text : undefined;
};
