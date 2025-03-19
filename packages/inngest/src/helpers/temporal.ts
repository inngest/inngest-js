import { type Temporal } from "temporal-polyfill";

/**
 * A type that represents a `Temporal.Duration` object.
 *
 * *Like types are available for many temporal objects, but not all of them.
 */
export type InstantLike = {
  epochSeconds?: number;
  epochMilliseconds?: number;
  epochMicroseconds?: number;
  epochNanoseconds?: number;
};

/**
 * Asserts that the given `input` is a `Temporal.Duration` object.
 */
export const isTemporalDuration = (
  /**
   * The input to check.
   */
  input: unknown
): input is Temporal.Duration => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (input as any)[Symbol.toStringTag] === "Temporal.Duration";
  } catch {
    return false;
  }
};

/**
 * Asserts that the given `input` is a `Temporal.TimeZone` object.
 */
export const isTemporalInstant = (
  /**
   * The input to check.
   */
  input: unknown
): input is Temporal.Instant => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (input as any)[Symbol.toStringTag] === "Temporal.Instant";
  } catch {
    return false;
  }
};

/**
 * Asserts that the given `input` is a `Temporal.ZonedDateTime` object.
 */
export const isTemporalZonedDateTime = (
  /**
   * The input to check.
   */
  input: unknown
): input is Temporal.ZonedDateTime => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (input as any)[Symbol.toStringTag] === "Temporal.ZonedDateTime";
  } catch {
    return false;
  }
};

/**
 * Converts a given `Date`, `string`, `Temporal.Instant`, or
 * `Temporal.ZonedDateTime` to an ISO 8601 string.
 */
export const getISOString = (
  time: Date | string | InstantLike | Temporal.ZonedDateTimeLike
): string => {
  if (typeof time === "string") {
    return new Date(time).toISOString();
  }

  if (time instanceof Date) {
    return time.toISOString();
  }

  if (isTemporalZonedDateTime(time)) {
    return time.toInstant().toString();
  }

  if (isTemporalInstant(time)) {
    return time.toString();
  }

  throw new TypeError("Invalid date input");
};
