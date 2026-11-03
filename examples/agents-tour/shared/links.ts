/**
 * @module
 * Links from inline code in a page's text to the code it names. A span that
 * equals a file name opens that tab; any other span is looked up in the
 * page's files, in tab order: a declaration first (`export const hello`,
 * `function hello`, a property key such as `id:`), then any whole-token
 * occurrence. A quoted value matches the string literal in either quote
 * style, and a call or dotted name matches with or without its `()`.
 */

export interface LinkFile {
  name: string;
  content: string;
}

export interface CodeTarget {
  file: string;
  // 1-based, and 0 for a file-name link, which only opens the tab.
  line: number;
  column: number;
  length: number;
}

/**
 * The inline code spans of `markdown`, in order.
 */
export const inlineCodeSpans = (markdown: string) => {
  const spans: string[] = [];

  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    spans.push(match[1] as string);
  }

  return spans;
};

const escapeRegex = (text: string) => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

// Whole-token: a word character at an edge may not touch another one.
const wholeToken = (text: string) => {
  const before = /^[\w$]/.test(text) ? "(?<![\\w$])" : "";
  const after = /[\w$]$/.test(text) ? "(?![\\w$])" : "";

  return `${before}${escapeRegex(text)}${after}`;
};

const locate = (
  files: readonly LinkFile[],
  pattern: RegExp,
  // Which part of the match is the token to highlight.
  pick: (match: RegExpExecArray) => { offset: number; length: number },
): CodeTarget | undefined => {
  for (const file of files) {
    const match = pattern.exec(file.content);

    if (match) {
      const { offset, length } = pick(match);
      const index = match.index + offset;
      const before = file.content.slice(0, index).split("\n");

      return {
        file: file.name,
        line: before.length,
        column: (before.at(-1) as string).length + 1,
        length,
      };
    }
  }

  return undefined;
};

/**
 * Finds the code `span` names in `files` (in the order given), or undefined.
 */
export const resolveSpan = (
  span: string,
  files: readonly LinkFile[],
): CodeTarget | undefined => {
  const text = span.trim();

  if (!text) {
    return undefined;
  }

  const named = files.find((file) => {
    return file.name === text;
  });

  if (named) {
    return { file: named.name, line: 0, column: 0, length: 0 };
  }

  const quoted = /^(["'])(.*)\1$/.exec(text);

  if (quoted) {
    const inner = escapeRegex(quoted[2] as string);

    return locate(files, new RegExp(`(["'\`])${inner}\\1`), (match) => {
      return { offset: 0, length: match[0].length };
    });
  }

  const name = text.replace(/\(\s*\)$/, "");
  const token = wholeToken(name);

  if (/^[\w$]+$/.test(name)) {
    const declared = locate(
      files,
      new RegExp(
        `\\b(?:const|let|var|function\\*?|class|type|interface|enum)\\s+(${token})|(?<![\\w$.])(${token})\\s*:(?!:)`,
        "d",
      ),
      (match) => {
        const [start = match.index] = match.indices?.[1] ??
          match.indices?.[2] ?? [match.index];

        return { offset: start - match.index, length: name.length };
      },
    );

    if (declared) {
      return declared;
    }
  }

  return locate(files, new RegExp(token), () => {
    return { offset: 0, length: name.length };
  });
};
