/**
 * @module
 * A stand-in for `Temporal.Duration` in tests. The SDK recognizes one by its
 * `Symbol.toStringTag` brand, so this needs no Temporal polyfill.
 */

import type { Duration } from "../types.ts";

/** A `Temporal.Duration`-shaped value that is `ms` long (or has calendar units, if given). */
export const temporalDuration = (
  ms: number,
  calendar: { weeks?: number } = {},
): Duration => {
  const duration = {
    [Symbol.toStringTag]: "Temporal.Duration" as const,
    years: 0,
    months: 0,
    weeks: calendar.weeks ?? 0,
    total: () => {
      return ms;
    },
  };

  return duration;
};
