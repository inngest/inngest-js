import ms, { type StringValue } from "ms";
import { type DurationLike, isTemporalDuration } from "./temporal.ts";

/**
 * Anything that describes a length of time: a number of milliseconds, a string
 * `ms` understands (`"30s"`, `"2h"`, `"1d"`), a compound string like `"1h30m"`,
 * or a `Temporal.Duration`.
 */
export type DurationInput = number | string | DurationLike;

/**
 * Parse an `ms` string, or a compound string like `"1h30m"` or `"1h 30m"`
 * (the sum of its parts), to milliseconds.
 */
const parseString = (input: string): number | undefined => {
  // Split between a unit and the next number, so each part is an `ms` string.
  const parts = input.trim().split(/(?<=[a-z])\s*(?=\d)/i);

  // Every part of a compound string needs a unit, including the last.
  if (parts.length > 1 && !/[a-z]$/i.test(parts[parts.length - 1] ?? "")) {
    return undefined;
  }

  let total = 0;

  for (const part of parts) {
    // `ms` throws on an empty string.
    const value = part ? ms(part as StringValue) : undefined;

    if (typeof value !== "number") {
      return undefined;
    }

    total += value;
  }

  return total;
};

/**
 * Convert a {@link DurationInput} to a positive, whole number of
 * milliseconds. Throws an `Error` naming the value (`options.name`) if the
 * input is malformed, not positive, or a `Temporal.Duration` with calendar
 * years, months or weeks (their length depends on the calendar).
 *
 * Temporal values are detected by their brand, so no Temporal polyfill is
 * needed or imported.
 */
export const durationToMs = (
  duration: unknown,
  options: { name?: string } = {},
): number => {
  const name = options.name ?? "duration";
  let milliseconds: number | undefined;

  if (typeof duration === "number") {
    milliseconds = duration;
  } else if (typeof duration === "string") {
    milliseconds = parseString(duration);
  } else if (isTemporalDuration(duration)) {
    if (duration.years || duration.months || duration.weeks) {
      throw new Error(
        `${name} cannot contain calendar years, months, or weeks`,
      );
    }

    milliseconds = duration.total({ unit: "milliseconds" });
  }

  if (
    typeof milliseconds !== "number" ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0
  ) {
    throw new Error(`${name} must be a positive, whole number of milliseconds`);
  }

  return milliseconds;
};
