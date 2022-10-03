/**
 * Returns a boolean representing whether a string was `"true"` or `"false"`
 * when lowercased and trimmed.
 *
 * If the string was neither, will return `null`.
 */
export const strBoolean = (str: string | undefined): boolean | null => {
  const trimmed = str?.toLowerCase().trim();

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  return null;
};
