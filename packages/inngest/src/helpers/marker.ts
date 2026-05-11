import type { DeferredFunction } from "../components/DeferredFunction.ts";

/**
 * Property name used to stamp SDK-internal metadata onto objects. The tilde
 * prefix signals "internal, don't touch."
 */
export const markerKey = "~inngest" as const;

export type Marker = {
  kind?: "deferredFunction";
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
