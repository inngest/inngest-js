/**
 * @module
 * The text edit behind the `edit` tool: one exact-string replacement that must
 * be unambiguous.
 */

export interface TextEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const matchLines = (text: string, search: string): number[] => {
  const lines: number[] = [];

  for (
    let at = text.indexOf(search);
    at !== -1;
    at = text.indexOf(search, at + search.length)
  ) {
    lines.push(text.slice(0, at).split("\n").length);
  }

  return lines;
};

/**
 * Replaces `old_string` in `text`. Throws, with a message for the model, when
 * it can't be done unambiguously.
 */
export const editText = (
  path: string,
  text: string,
  edit: TextEdit,
): string => {
  const { old_string: search, new_string: replacement } = edit;

  if (search === "") {
    throw new Error("old_string is empty");
  }

  if (search === replacement) {
    throw new Error("old_string and new_string are identical");
  }

  const lines = matchLines(text, search);

  if (lines.length === 0) {
    throw new Error(`old_string was not found in ${path}`);
  }

  if (lines.length > 1 && !edit.replace_all) {
    throw new Error(
      `old_string matches ${lines.length} times in ${path} (lines ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? ", ..." : ""}). Add surrounding context to make it unique, or set replace_all.`,
    );
  }

  return text.split(search).join(replacement);
};
