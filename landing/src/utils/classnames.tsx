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
