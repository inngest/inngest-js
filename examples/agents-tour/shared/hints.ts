/**
 * @module
 * Key hints in page text. A token such as `{Run}` names an action in the key
 * table (by id, in any case); the site shows the action's label in bold with
 * its key for the reader's platform. Code in backticks is left alone.
 */
const token = /\{([A-Za-z]+)\}/g;

/**
 * The names of the tokens in `markdown`, outside code.
 */
export const hintTokens = (markdown: string) => {
  const names: string[] = [];

  for (const line of markdown.split("\n")) {
    for (const piece of line.split(/`[^`]*`/)) {
      for (const match of piece.matchAll(token)) {
        names.push(match[1] as string);
      }
    }
  }

  return names;
};

/**
 * The action a token names, or undefined.
 */
export const actionNamed = <T extends { id: string }>(
  table: readonly T[],
  name: string,
) => {
  return table.find((def) => {
    return def.id.toLowerCase() === name.toLowerCase();
  });
};

/**
 * Replaces each token in `text` with `render(action)`; a token that names no
 * action stays as written.
 */
export const replaceHints = <T extends { id: string }>(
  text: string,
  table: readonly T[],
  render: (action: T) => string,
) => {
  return text.replace(token, (whole, name: string) => {
    const action = actionNamed(table, name);

    return action ? render(action) : whole;
  });
};
