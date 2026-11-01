/**
 * Mapping a path a tool printed to a path in the repository. Machines check
 * the repository out at `/work`, so a path under it is relative to the
 * checkout, and a relative one is relative to the command's directory.
 *
 * @module
 */

const work = "/work";

/** `a/b/../c` as `a/c`, or `undefined` when it climbs out of its start. */
const normalise = (path: string): string | undefined => {
  const parts: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      if (parts.length === 0) {
        return undefined;
      }

      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return parts.join("/");
};

/**
 * The repository path of `file`, printed by a command run in `cwd`. Files
 * outside the checkout have no repository path.
 */
export const repoPathOf = (file: string, cwd = work): string | undefined => {
  const plain = file.replace(/^file:\/\//, "").replaceAll("\\", "/");

  const inRepo = (absolute: string): string | undefined => {
    return absolute === work || absolute.startsWith(`${work}/`)
      ? normalise(absolute.slice(work.length))
      : undefined;
  };

  const path = plain.startsWith("/")
    ? inRepo(plain)
    : inRepo(`${cwd}/${plain}`);

  return path === "" ? undefined : path;
};
