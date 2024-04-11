import { type Temporal } from "@js-temporal/polyfill";

export const isTemporalDuration = (
  input: unknown
): input is Temporal.Duration => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (input as any)[Symbol.toStringTag] === "Temporal.Duration";
  } catch {
    return false;
  }
};

export const isTemporalInstant = (
  input: unknown
): input is Temporal.Instant => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (input as any)[Symbol.toStringTag] === "Temporal.Instant";
  } catch {
    return false;
  }
};

export const isTemporalZonedDateTime = (
  input: unknown
): input is Temporal.ZonedDateTime => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (input as any)[Symbol.toStringTag] === "Temporal.ZonedDateTime";
  } catch {
    return false;
  }
};
