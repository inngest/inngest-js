import type { DeferredFunction } from "../components/DeferredFunction.ts";

/**
 * Property name used to stamp SDK-internal metadata onto objects. The tilde
 * prefix signals "internal, don't touch."
 */
export const markerKey = "~inngest" as const;

export const Kind = {
  deferredFunction: "deferredFunction",
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/**
 * Shape of the SDK-internal marker bag. Each consumer sets only the fields
 * it cares about; readers should narrow on the field they care about.
 */
export type Marker = {
  kind?: Kind;
};

function getMarker(value: unknown): Marker | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const m = (value as { [markerKey]?: unknown })[markerKey];
  if (typeof m !== "object" || m === null) {
    return undefined;
  }
  return m as Marker;
}

export function isDeferredFunction(
  value: unknown,
): value is DeferredFunction.Any {
  return getMarker(value)?.kind === "deferredFunction";
}
