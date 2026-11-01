/**
 * @module
 * Where the messages of an inbox are in a run's state. The executor saves each
 * message as its own step whose value is the event plus the inbox it belongs to
 * and the sources that matched: `{ data, inbox, src }`. The step id is opaque,
 * so a message is told apart by that value. The messages of an inbox, in the
 * order the executor saved them, are the run's stack filtered by it.
 */
import hashjs from "hash.js";
import { subscriptionMessagePrefix } from "./subscription.ts";

const { sha1 } = hashjs;

/**
 * The id the executor knows an op by: the hash of the step's ID.
 */
export const hashedStepId = (id: string): string => {
  return sha1().update(id).digest("hex");
};

interface MessageValue {
  data: unknown;
  inbox: string;
  src: string[];
}

/**
 * Whether a saved step value is a message of an inbox.
 */
export const isInboxMessage = (value: unknown): value is MessageValue => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const v = value as Partial<MessageValue>;

  return typeof v.inbox === "string" && Array.isArray(v.src) && "data" in v;
};

/**
 * The events an inbox received, in the order the executor saved them.
 * @param inbox The hashed ID of the step that opened the inbox.
 * @param stack The run's stack: step IDs in the order they were saved.
 * @param stepState The run's step state by step ID.
 */
export const inboxMessages = (
  inbox: string,
  stack: readonly string[],
  stepState: Record<string, { data?: unknown } | undefined>,
): unknown[] => {
  const messages: unknown[] = [];

  for (const id of stack) {
    const value = stepState[id]?.data;

    if (isInboxMessage(value) && value.inbox === inbox) {
      messages.push(value.data);
    }
  }

  return messages;
};

/**
 * The steps of a run that are waited for when its state is replayed: every
 * step but the messages of an inbox, which are read from the state and never
 * requested. Only a step's ID and saved value count.
 * @param stack The run's stack: step IDs in the order they were saved.
 * @param stepState The run's step state by step ID.
 */
export const unseenSteps = (
  stack: readonly string[],
  stepState: Record<string, { data?: unknown } | undefined>,
): string[] => {
  return stack.filter((id) => {
    return (
      !id.startsWith(subscriptionMessagePrefix) &&
      !isInboxMessage(stepState[id]?.data)
    );
  });
};
