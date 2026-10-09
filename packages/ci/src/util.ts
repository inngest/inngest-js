/**
 * Small shared helpers: hashing, durations, glob matching, formatting,
 * and running local git.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { CiUsageError } from "./errors.ts";

const exec = promisify(execFile);

/**
 * Hash a string to a short, stable hex digest. Used for cache keys and for
 * shortening names that would otherwise be too long.
 */
export const hash = (input: string, length = 16): string => {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
};

/**
 * Turn a scope path into something safe for a sandbox name.
 */
export const slug = (input: string): string => {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

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
export const truncateLabel = (label: string, max = 60): string => {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
};

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
export const shellEscape = (value: string): string => {
  return `'${value.split("'").join(`'\\''`)}'`;
};

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

        out += `(?:${options.map(escapeRegExp).join("|")})`;

        i = end + 1;

        continue;
      }
    }

    out += escapeRegExp(char as string);

    i += 1;
  }

  return new RegExp(`^${out}$`);
};

const escapeRegExp = (input: string): string => {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/**
 * Whether a path matches any of the given glob patterns.
 */
export const matchesAny = (path: string, patterns: string[]): boolean => {
  return patterns.some((pattern) => {
    return globToRegExp(pattern).test(path);
  });
};

/**
 * Filter a list of paths by include and ignore patterns.
 */
export const filterPaths = (
  paths: string[],
  opts: { include?: string[]; ignore?: string[] },
): string[] => {
  const include = opts.include?.length ? opts.include : ["**"];
  const ignore = opts.ignore ?? [];

  return paths.filter((path) => {
    return matchesAny(path, include) && !matchesAny(path, ignore);
  });
};

const msPerUnit: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a duration string like `"10m"` into milliseconds. Only the small
 * subset CI uses is supported, because these are written by hand in pipelines.
 * The whole string must be made of durations, so a typo fails instead of
 * silently changing a timeout.
 */
export const durationToMs = (duration: string): number => {
  if (!/^\s*(?:\d+\s*(?:ms|s|m|h|d|w)\s*)+$/.test(duration)) {
    throw new CiUsageError(
      `Could not parse duration "${duration}". Use a number and a unit, like "90s", "10m" or "1h30m". Units are ms, s, m, h, d and w.`,
    );
  }

  let total = 0;

  for (const match of duration.matchAll(/(\d+)\s*(ms|s|m|h|d|w)/g)) {
    total += Number(match[1]) * (msPerUnit[match[2] as string] as number);
  }

  return total;
};

/**
 * Stringify a value so that equal values give equal strings whatever order
 * their object keys were written in.
 */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => {
        return stableStringify(item);
      })
      .join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => {
        return item !== undefined;
      })
      .sort(([left], [right]) => {
        return left < right ? -1 : 1;
      })
      .map(([key, item]) => {
        return `${JSON.stringify(key)}:${stableStringify(item)}`;
      });

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
};

const hasErrorCode = (error: unknown, code: string): boolean => {
  const { code: own, cause } = (error ?? {}) as {
    code?: string;
    cause?: { code?: string };
  };

  return own === code || cause?.code === code;
};

/**
 * Whether the Sandbox API said the machine doesn't exist, which is the only
 * failure cleanup may ignore.
 */
export const isSandboxNotFound = (error: unknown): boolean => {
  return hasErrorCode(error, "sandbox_not_found");
};

/**
 * Whether the Sandbox API said the snapshot doesn't exist, which is fine when
 * deleting one that is already gone.
 */
export const isSnapshotNotFound = (error: unknown): boolean => {
  return hasErrorCode(error, "sandbox_snapshot_not_found");
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

/** Fixed wording for the Sandbox errors that are worth naming. */
const codeReasons = new Map([
  ["cloud_login_required", "not logged in to Inngest"],
  ["environment_required", "no Inngest environment selected"],
  ["access_denied", "Sandboxes not enabled for your account"],
  ["sandbox_start_failed", "machine failed to start"],
]);

/**
 * A failure reason short enough for a narrow column or a check title. Known
 * Sandbox errors get fixed wording, matched by `code` (or the cause's);
 * anything else is its first non-empty line without an `Error:` style prefix
 * or trailing period, capped at 60 characters. No message gives an empty
 * string.
 */
export const shortReason = (error: unknown): string => {
  const { code, message, cause } = (error ?? {}) as {
    code?: string;
    message?: string;
    cause?: { code?: string };
  };
  const text = typeof message === "string" ? message : "";
  const codes = [code, cause?.code];

  const known = codes
    .map((candidate) => {
      return codeReasons.get(String(candidate));
    })
    .find(Boolean);

  if (known) {
    return known;
  }

  if (
    codes.includes("sandbox_start_timed_out") ||
    /did not reach RUNNING/i.test(text)
  ) {
    const ms = Number(/within (\d+) milliseconds/i.exec(text)?.[1]);

    if (!Number.isFinite(ms)) {
      return "machine didn't start";
    }

    const waited = ms % 60_000 === 0 ? `${ms / 60_000}m` : formatDuration(ms);

    return `machine didn't start in ${waited}`;
  }

  const first = text.split("\n").find((part) => {
    return part.trim();
  });
  const line = (first ?? "")
    .trim()
    .replace(/^(?:\w*Error:\s*)+/, "")
    .replace(/\.$/, "");

  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
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

/**
 * Run `git` in a local directory and return its stdout.
 */
export const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
};

/** The message of anything thrown, whether or not it's an `Error`. */
export const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)$/;

const namePattern = /^[A-Za-z0-9._-]+$/;

/** Split `owner/name`, or say what a repository should look like. */
export const parseRepo = (
  fullName: string,
): { owner: string; name: string } => {
  const [owner, name, ...rest] = fullName.split("/");

  if (
    !owner ||
    !name ||
    rest.length > 0 ||
    !ownerPattern.test(owner) ||
    !namePattern.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new CiUsageError(
      `\`repo\` must be "owner/name", but got "${fullName}".`,
    );
  }

  return { owner, name };
};
