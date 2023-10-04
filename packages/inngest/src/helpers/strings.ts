import { sha256 } from "hash.js";
import ms from "ms";
import { type DelimiterCase, type Join, type Words } from "string-ts";
import { type TimeStr } from "../types";
import { type FilterLetterOrNumber } from "./types";
export { default as stringify } from "json-stringify-safe";

const slugifyJoiner = "-" as const;

/**
 * Returns a slugified string used to generate consistent IDs.
 *
 * This can be used to generate a consistent ID for a function when migrating
 * from v2 to v3 of the SDK.
 *
 * @public
 */
export const slugify = <T extends string>(str: T): Slugify<T> => {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, slugifyJoiner)
    .replace(/-+/g, slugifyJoiner)
    .split(slugifyJoiner)
    .filter(Boolean)
    .join(slugifyJoiner) as Slugify<T>;
};

/**
 * Slugify the given string `T`.
 */
export type Slugify<T extends string> = Lowercase<
  Join<
    FilterLetterOrNumber<Words<DelimiterCase<T, typeof slugifyJoiner>>>,
    typeof slugifyJoiner
  >
>;

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
  input: string | number | Date
): string => {
  if (input instanceof Date) {
    return input.toISOString();
  }

  const milliseconds: number = typeof input === "string" ? ms(input) : input;

  const [, timeStr] = periods.reduce<[number, string]>(
    ([num, str], [suffix, period]) => {
      const numPeriods = Math.floor(num / period);

      if (numPeriods > 0) {
        return [num % period, `${str}${numPeriods}${suffix}`];
      }

      return [num, str];
    },
    [milliseconds, ""]
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
