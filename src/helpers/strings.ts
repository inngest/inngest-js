/**
 * Returns a slugified string used ot generate consistent IDs.
 */
export const slugify = (str: string): string => {
  const join = "-";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, join)
    .replace(/-+/g, join)
    .split(join)
    .filter(Boolean)
    .join(join);
};
