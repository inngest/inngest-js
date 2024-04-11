import { type Temporal } from "@js-temporal/polyfill";
import { sha256 } from "hash.js";
import { default as safeStringify } from "json-stringify-safe";
import ms from "ms";
import { type TimeStr } from "../types";
import {
  isTemporalDuration,
  isTemporalInstant,
  isTemporalZonedDateTime,
} from "./temporal";

/**
 * Safely `JSON.stringify()` an `input`, handling circular refernences and
 * removing `BigInt` values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stringify = (input: any): string => {
  return safeStringify(input, (key, value) => {
    if (typeof value !== "bigint") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
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
 * Convert a given `Date`, `Temporal`, `number`, or `ms`-compatible `string` to a
 * Inngest sleep-compatible time string (e.g. `"1d"` or `"2h3010s"`).
 */
export const timeStr = (
  /**
   * The future date to use to convert to a time string.
   */
  input:
    | string
    | number
    | Date
    | Temporal.Duration
    | Temporal.DurationLike // TODO
    | Temporal.Instant
    | Temporal.ZonedDateTime
): string => {
  switch (true) {
    case typeof input === "string":
      return timeStrFromMs(ms(input));

    case typeof input === "number":
      return timeStrFromMs(input);

    case input instanceof Date:
      return input.toISOString();

    case isTemporalDuration(input):
      return timeStrFromMs(
        input.round("millisecond").total({ unit: "millisecond" })
      );

    case isTemporalInstant(input):
      return input.round("millisecond").toString();

    case isTemporalZonedDateTime(input):
      return input.toInstant().round("millisecond").toString();

    default:
      throw new Error(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `Failed to create time string from input: ${input as any}`
      );
  }
};

const timeStrFromMs = (ms: number): TimeStr => {
  const [, timeStr] = periods.reduce<[number, string]>(
    ([num, str], [suffix, period]) => {
      const numPeriods = Math.floor(num / period);

      if (numPeriods > 0) {
        return [num % period, `${str}${numPeriods}${suffix}`];
      }

      return [num, str];
    },
    [ms, ""]
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
