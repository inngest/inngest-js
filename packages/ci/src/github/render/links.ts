/**
 * The row of links and actions under a check's callout. Every link appears
 * once, however many places in the data name it.
 *
 * @module
 */

/** A markdown link. */
export const link = (label: string, url: string): string => {
  return `[${label}](${url})`;
};

/** The URL a markdown item links to, if it links to one. */
const urlOf = (item: string): string | undefined => {
  return item.match(/\]\(([^)]+)\)/)?.[1];
};

/**
 * One line: `lead`, then the items separated by dots. An item that links to a
 * URL an earlier item already links to, or that repeats one, is dropped.
 * Returns an empty string when nothing is left, so the caller can skip it.
 */
export const linksRow = (
  lead: string,
  items: Array<string | undefined>,
): string => {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const item of items) {
    if (!item) {
      continue;
    }

    const key = urlOf(item) ?? item;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    kept.push(item);
  }

  return kept.length === 0 ? "" : `${lead} ${kept.join(" · ")}`;
};
