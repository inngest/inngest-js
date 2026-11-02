/**
 * @module
 * How an event name matches a trigger's name, which may end in a wildcard.
 */

/**
 * Whether an event name matches a trigger name. A name ending in `*` matches
 * every event name that starts with what comes before it (`user/*` matches
 * `user/created`); any other name matches only itself.
 */
export function matchesEventName(
  eventName: string,
  triggerName: string,
): boolean {
  if (triggerName.endsWith("*")) {
    return eventName.startsWith(triggerName.slice(0, -1));
  }

  return eventName === triggerName;
}
