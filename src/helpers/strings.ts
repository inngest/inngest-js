import ms from "ms";
import { TimeStr } from "../types";

/**
 * Returns a slugified string used ot generate consistent IDs.
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

  /**
   * Optionally provide a date to use as the base for the calculation.
   */
  now = new Date()
): TimeStr => {
  let date = input;

  if (typeof date === "string" || typeof date === "number") {
    const numTimeout = typeof date === "string" ? ms(date) : date;
    date = new Date(Date.now() + numTimeout);
  }

  now.setMilliseconds(0);
  date.setMilliseconds(0);

  const isValidDate = !isNaN(date.getTime());

  if (!isValidDate) {
    throw new Error("Invalid date given to convert to time string");
  }

  const timeNum = date.getTime() - now.getTime();

  const [, timeStr] = periods.reduce<[number, string]>(
    ([num, str], [suffix, period]) => {
      const numPeriods = Math.floor(num / period);

      if (numPeriods > 0) {
        return [num % period, `${str}${numPeriods}${suffix}`];
      }

      return [num, str];
    },
    [timeNum, ""]
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
