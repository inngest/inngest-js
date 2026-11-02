/**
 * @module
 * EXPERIMENTAL: Text helpers for output that has a length limit.
 */

/**
 * Cuts `text` to at most `max` characters, ending in an ellipsis, without
 * splitting a surrogate pair.
 */
export const truncate = (
  /**
   * The text.
   */
  text: string,

  /**
   * The most characters (UTF-16 units) to keep, the ellipsis included.
   */
  max: number,
): string => {
  if (text.length <= max) {
    return text;
  }

  let end = max - 1;
  const last = text.charCodeAt(end - 1);

  // A high surrogate at the cut would leave half of a pair.
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }

  return `${text.slice(0, end)}…`;
};
