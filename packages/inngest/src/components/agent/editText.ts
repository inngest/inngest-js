/**
 * @module
 * The text edit behind the `edit` tool: exact-string replacements that must be
 * unambiguous, applied all together or not at all.
 */

export interface TextEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const lineOf = (text: string, index: number): number => {
  return text.slice(0, index).split("\n").length;
};

const matchLines = (text: string, search: string): number[] => {
  const lines: number[] = [];

  for (
    let at = text.indexOf(search);
    at !== -1;
    at = text.indexOf(search, at + search.length)
  ) {
    lines.push(lineOf(text, at));
  }

  return lines;
};

/**
 * Applies each edit in order to the result of the one before. Throws, with a
 * message for the model, at the first edit that can't be applied, so the
 * caller never sees a half-edited text.
 */
export const editText = (
  path: string,
  text: string,
  edits: TextEdit[],
): string => {
  let result = text;

  for (const [index, edit] of edits.entries()) {
    const label =
      edits.length > 1 ? `Edit ${index + 1} of ${edits.length}: ` : "";
    const { old_string: search, new_string: replacement } = edit;

    if (search === "") {
      throw new Error(`${label}old_string is empty`);
    }

    if (search === replacement) {
      throw new Error(`${label}old_string and new_string are identical`);
    }

    const lines = matchLines(result, search);

    if (lines.length === 0) {
      throw new Error(`${label}old_string was not found in ${path}`);
    }

    if (lines.length > 1 && !edit.replace_all) {
      throw new Error(
        `${label}old_string matches ${lines.length} times in ${path} (lines ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? ", ..." : ""}). Add surrounding context to make it unique, or set replace_all.`,
      );
    }

    result = result.split(search).join(replacement);
  }

  return result;
};
