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

const { sha1 } = hashjs;

/**
 * Starts the ID of every message step.
 */
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

/**
 * Whether the run holds the step that closes a subscription.
 * @param key The subscription ID.
 * @param stack The run's stack: step IDs in the order they were saved.
 */
export const subscriptionClosed = (
  key: string,
  stack: readonly string[],
): boolean => {
  return stack.includes(
    `${subscriptionMessagePrefix}closed:${sha1().update(key).digest("hex")}`,
  );
};

/**
 * Whether a read's timer fired before the message it waited for arrived. The
 * stack is the order things happened in, so the answer is the same on every
 * replay, however late the message was saved.
 * @param key The subscription ID.
 * @param seq The message the read waited for, starting at 1.
 * @param timerId The hashed ID of the timer step.
 * @param stack The run's stack: step IDs in the order they were saved.
 */
export const timerWon = (
  key: string,
  seq: number,
  timerId: string,
  stack: readonly string[],
): boolean => {
  const timerAt = stack.indexOf(timerId);
  if (timerAt < 0) {
    return false;
  }

  const prefix = subscriptionMessageIdPrefix(key);
  const messageId = stack.filter((id) => {
    return id.startsWith(prefix);
  })[seq - 1];

  return messageId === undefined || timerAt < stack.indexOf(messageId);
};

/**
 * The steps of a run that are waited for when its state is replayed: every
 * step but the messages of a subscription, which are read from the state and
 * never requested. Only the ID counts, never what a step returned.
 * @param stack The run's stack: step IDs in the order they were saved.
 */
export const stepsToBeSeen = (stack: readonly string[]): string[] => {
  return stack.filter((id) => {
    return !id.startsWith(subscriptionMessagePrefix);
  });
};
