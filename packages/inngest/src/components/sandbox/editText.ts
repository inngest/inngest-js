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

const MAX_HINT_LINES = 40;
const MIN_SIMILARITY = 0.5;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

const bigrams = (s: string): Map<string, number> => {
  const grams = new Map<string, number>();

  for (let i = 0; i < s.length - 1; i++) {
    const gram = s.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }

  return grams;
};

/** Dice coefficient over character bigrams: 1 is the same text, 0 shares nothing. */
const similarity = (
  target: Map<string, number>,
  targetSize: number,
  other: string,
): number => {
  let shared = 0;
  let otherSize = 0;

  for (const [gram, count] of bigrams(other)) {
    otherSize += count;
    shared += Math.min(count, target.get(gram) ?? 0);
  }

  return targetSize + otherSize === 0
    ? 0
    : (2 * shared) / (targetSize + otherSize);
};

/** 0-based start of the only place `want` matches line by line once trimmed. */
const whitespaceOnlyMatch = (
  lines: string[],
  want: string[],
): number | undefined => {
  const trimmed = want.map((l) => l.trim());
  const starts: number[] = [];

  for (let i = 0; i + want.length <= lines.length; i++) {
    if (trimmed.every((w, j) => lines[i + j]?.trim() === w)) {
      starts.push(i);
    }
  }

  return starts.length === 1 ? starts[0] : undefined;
};

/**
 * The window of lines most similar to `target`, trying `n` lines and one fewer
 * or more, since models often drop or add a line.
 */
const mostSimilarWindow = (
  lines: string[],
  target: string,
  n: number,
): { start: number; len: number } | undefined => {
  const grams = bigrams(target);
  const size = target.length - 1;
  let best = { start: -1, len: n, score: 0 };

  for (const len of [n, n - 1, n + 1]) {
    if (len < 1 || len > lines.length) {
      continue;
    }

    for (let i = 0; i + len <= lines.length; i++) {
      const score = similarity(
        grams,
        size,
        squash(lines.slice(i, i + len).join("\n")),
      );

      if (score > best.score) {
        best = { start: i, len, score };
      }
    }
  }

  return best.start < 0 || best.score < MIN_SIMILARITY ? undefined : best;
};

/**
 * Hint appended to the "not found" error: the closest text in the file, quoted
 * exactly so the model can copy it. Never applied automatically.
 */
const closestMatchHint = (text: string, search: string): string => {
  const lines = text.split("\n");
  const want = search.replace(/^\n+|\n+$/g, "").split("\n");
  const target = squash(want.join("\n"));

  if (!target) {
    return " Copy the lines from the file exactly.";
  }

  const at = whitespaceOnlyMatch(lines, want);
  if (at !== undefined) {
    return ` It matches lines ${at + 1}-${at + want.length} except for whitespace (indentation or line breaks). Those lines are exactly:\n${lines.slice(at, at + want.length).join("\n")}`;
  }

  const best = mostSimilarWindow(
    lines,
    target,
    Math.min(want.length, lines.length),
  );
  if (!best) {
    return " Nothing in the file is close to it; the file may have changed since you copied it. Read it and copy the lines exactly.";
  }

  const shown = lines.slice(
    best.start,
    best.start + Math.min(best.len, MAX_HINT_LINES),
  );
  const more =
    best.len > MAX_HINT_LINES
      ? `\n... (${best.len - MAX_HINT_LINES} more lines)`
      : "";

  return ` The closest text is lines ${best.start + 1}-${best.start + best.len}. If that's what you meant, copy it into old_string exactly as it is here:\n${shown.join("\n")}${more}`;
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
    throw new Error(
      `old_string was not found in ${path}.${closestMatchHint(text, search)}`,
    );
  }

  if (lines.length > 1 && !edit.replace_all) {
    throw new Error(
      `old_string matches ${lines.length} times in ${path} (lines ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? ", ..." : ""}). Add surrounding context to make it unique, or set replace_all.`,
    );
  }

  return text.split(search).join(replacement);
};
