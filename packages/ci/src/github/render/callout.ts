/**
 * The callout that opens every check: one fact the reader came for, drawn as a
 * GitHub alert. Pure markdown, no data of its own.
 *
 * @module
 */

/** The alert kinds GitHub renders in check output. */
export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

/** A GitHub alert holding `text`, which may span several lines. */
export const callout = (kind: CalloutKind, text: string): string => {
  const body = text
    .split("\n")
    .map((line) => {
      return line === "" ? ">" : `> ${line}`;
    })
    .join("\n");

  return `> [!${kind.toUpperCase()}]\n${body}`;
};
