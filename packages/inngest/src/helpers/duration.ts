import ms, { type StringValue } from "ms";
import { type DurationLike, isTemporalDuration } from "./temporal.ts";

/**
 * Anything that describes a length of time: a number of milliseconds, a string
 * `ms` understands (`"30s"`, `"2h"`, `"1d"`) or a `Temporal.Duration`.
 */
export type DurationInput = number | string | DurationLike;

/**
 * Options for {@link durationToMs}.
 */
export interface DurationToMsOptions {
  /**
   * What to call the value in error messages, like `"cache.maxAge"`. Defaults
   * to `"duration"`.
   */
  name?: string;
}

const compoundToken = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
const compound = /^\s*(?:\d+(?:\.\d+)?\s*[a-z]+\s*)+$/i;

const parseString = (input: string): number | undefined => {
  try {
    return parseStringUnsafe(input);
  } catch {
    return undefined;
  }
};

const parseStringUnsafe = (input: string): number | undefined => {
  if (input.length > 100) {
    return undefined;
  }

  const direct = ms(input as StringValue);
  if (typeof direct === "number" && !Number.isNaN(direct)) {
    return direct;
  }

  // Compound strings like "1h30m" or "1h 30m" are the sum of their parts.
  if (!compound.test(input)) {
    return undefined;
  }

  let total = 0;
  for (const match of input.matchAll(compoundToken)) {
    const part = ms(`${match[1]}${match[2]}` as StringValue);
    if (typeof part !== "number" || Number.isNaN(part)) {
      return undefined;
    }

    total += part;
  }

  return total;
};

/**
 * Convert a {@link DurationInput} to a positive, whole number of
 * milliseconds. Throws an `Error` naming the value if the input is malformed,
 * not positive, or a `Temporal.Duration` with calendar years,
 * months or weeks (their length depends on the calendar).
 *
 * Strings are anything `ms` accepts, plus compound forms like `"1h30m"`.
 * Temporal values are detected by their brand, so no Temporal polyfill is
 * needed or imported.
 */
export const durationToMs = (
  duration: unknown,
  options: DurationToMsOptions = {},
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
    !Number.isFinite(milliseconds) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0
  ) {
    throw new Error(`${name} must be a positive, whole number of milliseconds`);
  }

  return milliseconds;
};
