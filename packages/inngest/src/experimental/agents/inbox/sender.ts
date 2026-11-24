/**
 * @module
 * EXPERIMENTAL: `msg.from`, who sent a message. An agent is a handle on the
 * sender's thread, so you can message it back; a plain function is its ID and
 * key, and cannot be messaged.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import { type ThreadHandle, threadHandle } from "../threads/thread.ts";
import type { SenderData } from "./events.ts";

/**
 * Who sent a message. The result of `message()` on an agent sender is
 * `unknown`: the sender's output is not known here.
 */
export type Sender =
  | ({ kind: "agent"; address: string } & ThreadHandle<unknown>)
  | { kind: "function"; id: string; key: string };

/**
 * The `Sender` of a message from its `data.from`. The chain depth and the
 * other internal fields of `data.from` are left out.
 * @param client Inngest client.
 * @param from The sender as it travels in the event.
 */
export const senderFrom = (client: Inngest.Any, from: SenderData): Sender => {
  if (from.kind === "agent") {
    return {
      kind: "agent",
      address: from.address,
      ...threadHandle<unknown>(client, from.address, from.key),
    };
  }

  return { kind: "function", id: from.id, key: from.key };
};
