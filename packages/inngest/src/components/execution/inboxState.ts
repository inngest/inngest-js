/**
 * @module
 * Where the messages of an inbox are in a run's state. The executor saves each
 * message as its own step whose value is the event plus the inbox it belongs to
 * and the sources that matched: `{ data, "inngest/inbox", src }`. The step id
 * is opaque, so a message is told apart by that reserved key, which no user
 * value carries. The messages of an inbox, in the
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

/**
 * The reserved key of a message step's value. It holds the id of the op that
 * opened the inbox.
 */
export const inboxKey = "inngest/inbox";

interface MessageValue {
  data: unknown;
  "inngest/inbox": string;
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

  return typeof v[inboxKey] === "string" && Array.isArray(v.src) && "data" in v;
};

/**
 * What a read of an inbox finds in the run's state.
 */
export type InboxRead =
  | { found: "message"; message: unknown; timedOut: boolean }
  | { found: "timeout" }
  | { found: "nothing" };

/**
 * What the read at a position of an inbox finds. Walking the stack in the order
 * the executor saved it, the first thing after the messages earlier reads took
 * is the answer: a message, or the `null` the executor saved when the read's
 * timeout passed. A message that arrived after a read timed out comes later in
 * the stack, so it is not that read's.
 *
 * When a timeout and a message raced and both were saved, the message is first
 * and the timeout is an ignored step: `timedOut` says it is in the stack, so
 * the caller can mark it as seen.
 * @param inbox The hashed ID of the step that opened the inbox.
 * @param taken How many messages earlier reads took.
 * @param wait The hashed ID of the read's wait op.
 * @param stack The run's stack: step IDs in the order they were saved.
 * @param stepState The run's step state by step ID.
 */
export const inboxRead = (
  inbox: string,
  taken: number,
  wait: string,
  stack: readonly string[],
  stepState: Record<string, { data?: unknown } | undefined>,
): InboxRead => {
  let seen = 0;
  let found: InboxRead = { found: "nothing" };

  for (const id of stack) {
    const value = stepState[id]?.data;

    if (isInboxMessage(value) && value[inboxKey] === inbox) {
      if (found.found === "nothing" && seen === taken) {
        found = { found: "message", message: value.data, timedOut: false };
      }

      seen += 1;
    } else if (id === wait) {
      if (found.found === "nothing") {
        return { found: "timeout" };
      }

      if (found.found === "message") {
        found.timedOut = true;
      }
    }
  }

  return found;
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
