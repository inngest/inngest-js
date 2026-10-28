/**
 * @module
 * Where the messages of a `step.subscribe()` subscription are in a run's state.
 *
 * The executor saves each message as the step `<prefix><hash of the
 * subscription ID>:<event ID>`, so the same event is one message and the order
 * of the messages is their order in the run's stack. The engine reads them out
 * of the state it was given; the subscription is in `agent/subscribe.ts`.
 */
import hashjs from "hash.js";

/**
 * Starts the ID of every message step.
 */
const { sha1 } = hashjs;

export const subscriptionMessagePrefix = "inngest-sub:";

/**
 * The ID prefix of a subscription's message steps.
 * @param key The subscription ID.
 */
export const subscriptionMessageIdPrefix = (key: string): string => {
  return `${subscriptionMessagePrefix}${sha1().update(key).digest("hex")}:`;
};

/**
 * The messages of a subscription, in the order the executor saved them.
 * @param key The subscription ID.
 * @param stack The run's stack: step IDs in the order they were saved.
 * @param stepState The run's step state by step ID.
 */
export const subscriptionMessages = (
  key: string,
  stack: readonly string[],
  stepState: Record<string, { data?: unknown } | undefined>,
): unknown[] => {
  const prefix = subscriptionMessageIdPrefix(key);

  return stack
    .filter((id) => {
      return id.startsWith(prefix);
    })
    .map((id) => {
      return stepState[id]?.data;
    });
};
