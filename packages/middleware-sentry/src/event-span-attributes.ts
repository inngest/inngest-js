/**
 * Span attributes for the triggering event. The full payload is opt-in so
 * personal data in `event.data` is not sent to Sentry by default.
 */
export function sentryEventSpanAttributes(
  event: { id?: string; name?: string },
  includeEventPayload: boolean,
): Record<string, string | undefined> {
  const eventTags = {
    "inngest.event.id": event.id,
    "inngest.event.name": event.name,
  };

  if (!includeEventPayload) {
    return eventTags;
  }

  return {
    ...eventTags,
    "inngest.event": JSON.stringify(event),
  };
}
