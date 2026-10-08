/**
 * Reading NUL-delimited git output, so paths with spaces, quotes or newlines
 * come through as they are rather than quoted. Shared by the local `changed()`
 * and `files()` cache key code.
 *
 * @module
 */

/**
 * The paths in `git status --porcelain -z --untracked-files=all` output.
 *
 * Each entry is `XY <path>`. A rename or copy is followed by a second field
 * holding the original path, which is skipped.
 */
export const parsePorcelainPaths = (output: string): string[] => {
  const fields = output.split("\0");
  const paths: string[] = [];

  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];

    if (!entry) {
      continue;
    }

    paths.push(entry.slice(3));

    if (/[RC]/.test(entry.slice(0, 2))) {
      i++;
    }
  }

  return paths;
};
