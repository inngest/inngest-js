import { sha256 } from "hash.js";

/**
 * Hash a string to a short, stable hex digest. Used for cache keys and for
 * shortening names that would otherwise be too long.
 */
export const hash = (input: string, length = 16): string =>
  sha256().update(input).digest("hex").slice(0, length);

/**
 * Turn a scope path into something safe for a sandbox name.
 */
export const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

/**
 * Sandbox names are limited to 255 characters, so long ones keep a readable
 * prefix and gain a hash suffix to stay unique.
 */
export const boundedName = (name: string, max = 255): string => {
  if (name.length <= max) {
    return name;
  }
  const suffix = `-${hash(name, 8)}`;
  return `${name.slice(0, max - suffix.length)}${suffix}`;
};

/**
 * Truncate a label for use in a step ID, keeping it readable.
 */
export const truncateLabel = (label: string, max = 60): string =>
  label.length <= max ? label : `${label.slice(0, max - 1)}…`;

/**
 * Keep the last `bytes` worth of a string, marking that it was cut.
 */
export const tail = (
  input: string,
  bytes: number,
): { text: string; truncated: boolean } => {
  if (input.length <= bytes) {
    return { text: input, truncated: false };
  }
  return { text: input.slice(input.length - bytes), truncated: true };
};

/**
 * Replace secret values with `***` wherever they appear.
 */
export const maskSecrets = (input: string, secrets: string[]): string => {
  let output = input;
  for (const secret of secrets) {
    if (secret) {
      output = output.split(secret).join("***");
    }
  }
  return output;
};

/**
 * Quote a value for `/bin/sh`, for `$.sh` only. `$` never shells out.
 */
export const shellEscape = (value: string): string =>
  `'${value.split("'").join(`'\\''`)}'`;

/**
 * A tiny glob matcher supporting `**`, `*`, `?`, and `{a,b}`.
 *
 * This is deliberately not a dependency: CI only needs to match repository
 * paths, and a few hundred bytes of regex beats another package.
 */
export const globToRegExp = (pattern: string): RegExp => {
  let out = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        const followedBySlash = pattern[i + 2] === "/";
        // `**/` matches any number of leading directories, including none.
        out += followedBySlash ? "(?:.*/)?" : ".*";
        i += followedBySlash ? 3 : 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end !== -1) {
        const options = pattern.slice(i + 1, end).split(",");
        out += `(?:${options.map((option) => escapeRegExp(option)).join("|")})`;
        i = end + 1;
        continue;
      }
    }

    out += escapeRegExp(char as string);
    i += 1;
  }

  return new RegExp(`^${out}$`);
};

const escapeRegExp = (input: string): string =>
  input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a path matches any of the given glob patterns.
 */
export const matchesAny = (path: string, patterns: string[]): boolean =>
  patterns.some((pattern) => globToRegExp(pattern).test(path));

/**
 * Filter a list of paths by include and ignore patterns.
 */
export const filterPaths = (
  paths: string[],
  opts: { include?: string[]; ignore?: string[] },
): string[] => {
  const include = opts.include?.length ? opts.include : ["**"];
  const ignore = opts.ignore ?? [];

  return paths.filter(
    (path) => matchesAny(path, include) && !matchesAny(path, ignore),
  );
};

/**
 * Parse a duration string like `"10m"` into milliseconds. Only the small
 * subset CI uses is supported, because these are written by hand in pipelines.
 */
export const durationToMs = (duration: string): number => {
  const matches = duration.matchAll(/(\d+)\s*(ms|s|m|h|d|w)/g);
  let total = 0;
  let found = false;

  for (const match of matches) {
    found = true;
    const value = Number(match[1]);
    switch (match[2]) {
      case "ms":
        total += value;
        break;
      case "s":
        total += value * 1000;
        break;
      case "m":
        total += value * 60_000;
        break;
      case "h":
        total += value * 3_600_000;
        break;
      case "d":
        total += value * 86_400_000;
        break;
      case "w":
        total += value * 604_800_000;
        break;
    }
  }

  if (!found) {
    throw new Error(`Could not parse duration "${duration}"`);
  }

  return total;
};

/**
 * Human-readable duration, like "1m 05s", for check titles.
 */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
};

/**
 * Relative time for check summaries, like "5h ago".
 */
export const formatRelative = (from: string, now = Date.now()): string => {
  const diff = Math.max(0, now - new Date(from).getTime());
  const minutes = Math.floor(diff / 60_000);

  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
};

const warned = new Set<string>();

/**
 * Warn at most once per key, so a deprecated option in a loop doesn't fill the
 * logs.
 */
export const warnOnce = (
  // biome-ignore lint/suspicious/noExplicitAny: any logger-ish
  logger: { warn: (...args: any[]) => void } | undefined,
  key: string,
  message: string,
): void => {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  (logger ?? console).warn({ feature: key }, message);
};

/**
 * Only for tests: forget which warnings have already been emitted.
 */
export const resetWarnings = (): void => {
  warned.clear();
};
