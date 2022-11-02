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
  ["ms", millisecond],
] as const;

/**
 * Convert a given `date` to a sleep-compatible time string (e.g. `"1d"` or
 * `"2h3010s"`).
 *
 * Can optionally provide a `now` date to use as the base for the calculation,
 * otherwise a new date will be created on invocation.
 */
export const dateToTimeStr = (
  /**
   * The future date to use to convert to a time string.
   */
  date: Date,

  /**
   * Optionally provide a date to use as the base for the calculation.
   */
  now = new Date()
): string => {
  const isValidDate = !isNaN(date.getTime());

  if (!isValidDate) {
    throw new Error("Invalid date given to convert to time string");
  }

  /**
   * TODO In this eventuality, should we smartly skip the sleep?
   *
   * We'd have to return two ops to Inngest, this being skipped and the
   * next.
   */
  if (date <= now) {
    throw new Error("Cannot sleep until a time in the past");
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

  return timeStr;
};
