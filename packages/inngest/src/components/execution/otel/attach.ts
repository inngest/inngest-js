/**
 * Extract the internal span processors array from a BasicTracerProvider.
 * Returns the mutable array if accessible, undefined otherwise.
 *
 * BasicTracerProvider._activeSpanProcessor is a MultiSpanProcessor,
 * which holds a _spanProcessors: SpanProcessor[] array.
 * Both are TypeScript `private` (not ES #private), so accessible at runtime.
 *
 * Wrapped in try/catch because this accesses internal OTel fields that may
 * change — must never crash the host app.
 */
export function getInternalSpanProcessors(
  provider: unknown,
): unknown[] | undefined {
  try {
    const active = (provider as Record<string, unknown>)?._activeSpanProcessor;
    if (typeof active !== "object" || active === null) return undefined;

    const arr = (active as Record<string, unknown>)._spanProcessors;
    return Array.isArray(arr) ? arr : undefined;
  } catch {
    return undefined;
  }
}
