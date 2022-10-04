/**
 * Given an object of classes as keys and booleans as values, conjoin any
 * classes with a boolean of `true`.
 *
 * Used to conditionally assign classes based on state in a slightly cleaner
 * manner than requiring `[""].join(" ")` everywhere.
 */
export const classNames = (classes: Record<string, boolean>): string => {
  const filtered = Object.entries(classes).reduce<string[]>(
    (acc, [c, shouldShow]) => {
      if (shouldShow) {
        return [...acc, c];
      }

      return acc;
    },
    []
  );

  return filtered.filter(Boolean).join(" ").trim();
};
