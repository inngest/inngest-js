import hashjs from "hash.js";
import { default as safeStringify } from "json-stringify-safe";
import ms from "ms";
import type { TimeStr } from "../types.ts";

const { sha256 } = hashjs;

/**
 * Safely `JSON.stringify()` an `input`, handling circular refernences and
 * removing `BigInt` values.
 */
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export const stringify = (input: any): string => {
  return safeStringify(input, (_key, value) => {
    if (typeof value !== "bigint") {
      return value;
    }
  });
};

/**
 * Returns a slugified string used to generate consistent IDs.
 *
 * This can be used to generate a consistent ID for a function when migrating
 * from v2 to v3 of the SDK.
 *
 * @public
 */
export const slugify = (str: string): string => {
  const join = "-";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, join)
    .replace(/-+/g, join)
    .split(join)
    .filter(Boolean)
    .join(join);
};

const millisecond = 1;
const second = millisecond * 1000;
const minute = second * 60;
const hour = minute * 60;
const day = hour * 24;
const week = day * 7;

/**
 * A collection of periods in milliseconds and their suffixes used when creating
 * time strings.
 */
const periods = [
  ["w", week],
  ["d", day],
  ["h", hour],
  ["m", minute],
  ["s", second],
] as const;

/**
 * Convert a given `Date`, `number`, or `ms`-compatible `string` to a
 * Inngest sleep-compatible time string (e.g. `"1d"` or `"2h3010s"`).
 *
 * Can optionally provide a `now` date to use as the base for the calculation,
 * otherwise a new date will be created on invocation.
 */
export const timeStr = (
  /**
   * The future date to use to convert to a time string.
   */
  input: string | number | Date,
): string => {
  if (input instanceof Date) {
    return input.toISOString();
  }

  const milliseconds: number =
    typeof input === "string" ? ms(input as `${number}`) : input;

  const [, timeStr] = periods.reduce<[number, string]>(
    ([num, str], [suffix, period]) => {
      const numPeriods = Math.floor(num / period);

      if (numPeriods > 0) {
        return [num % period, `${str}${numPeriods}${suffix}`];
      }

      return [num, str];
    },
    [milliseconds, ""],
  );

  return timeStr as TimeStr;
};

/**
 * Given an unknown input, stringify it if it's a boolean, a number, or a
 * string, else return `undefined`.
 */
export const stringifyUnknown = (input: unknown): string | undefined => {
  if (
    typeof input === "boolean" ||
    typeof input === "number" ||
    typeof input === "string"
  ) {
    return input.toString();
  }

  return;
};

export const hashEventKey = (eventKey: string): string => {
  return sha256().update(eventKey).digest("hex");
};

export const hashSigningKey = (signingKey: string | undefined): string => {
  if (!signingKey) {
    return "";
  }

  const prefix = signingKey.match(/^signkey-[\w]+-/)?.shift() || "";
  const key = signingKey.replace(/^signkey-[\w]+-/, "");

  // Decode the key from its hex representation into a bytestream
  return `${prefix}${sha256().update(key, "hex").digest("hex")}`;
};
