import hashjs from "hash.js";
import { default as safeStringify } from "json-stringify-safe";
import ms from "ms";
import { Temporal } from "temporal-polyfill";
import type { TimeStr } from "../types.ts";
import {
  type DurationLike,
  getISOString,
  type InstantLike,
  isTemporalDuration,
  isTemporalInstant,
  isTemporalZonedDateTime,
  type ZonedDateTimeLike,
} from "./temporal.ts";

const { sha256 } = hashjs;

/**
 * Constant-time equality check for two strings. Returns `false` immediately if
 * lengths differ; otherwise XOR-accumulates every char code so the total time
 * is independent of where (or whether) the strings diverge.
 *
 * Used for HMAC signature verification — `===`/`!==` short-circuit on the
 * first mismatched character and leak the matching-prefix length via timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Safely `JSON.stringify()` an `input`, handling circular refernences and
 * removing `BigInt` values.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional
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
 */
export const timeStr = (
  /**
   * The future date to use to convert to a time string.
   */
  input:
    | string
    | number
    | Date
    | DurationLike
    | InstantLike
    | ZonedDateTimeLike,
): string => {
  if (input instanceof Date) {
    return input.toISOString();
  }

  if (isTemporalInstant(input) || isTemporalZonedDateTime(input)) {
    return getISOString(input);
  }

  let milliseconds: number;
  if (isTemporalDuration(input)) {
    // `relativeTo` is required for calendar units (months/years/weeks). We
    // pass it as an ISO string rather than a Temporal object so this works
    // regardless of which Temporal implementation the user's Duration came
    // from (temporal-polyfill, @js-temporal/polyfill, native Temporal):
    // ISO strings are spec-defined and parsed by every implementation;
    // cross-polyfill object passing is not.
    milliseconds = input.total({
      unit: "milliseconds",
      relativeTo: Temporal.Now.plainDateTimeISO("UTC").toString(),
    });
  } else if (typeof input === "string") {
    milliseconds = ms(input as `${number}`);
  } else {
    milliseconds = input as number;
  }

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
  const key = removeSigningKeyPrefix(signingKey);

  // Decode the key from its hex representation into a bytestream
  return `${prefix}${sha256().update(key, "hex").digest("hex")}`;
};

export function removeSigningKeyPrefix(signingKey: string): string {
  return signingKey.replace(/^signkey-[\w]+-/, "");
}
