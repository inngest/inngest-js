/**
 * @module
 * Type tests for `InboxMessage`, which names what an inbox reads.
 */
import { expectTypeOf } from "vitest";
import type { EventPayload, Inbox, InboxMessage } from "../../index.ts";

describe("InboxMessage", () => {
  test("is the message type of an inbox", () => {
    expectTypeOf<InboxMessage<Inbox>>().toEqualTypeOf<EventPayload>();
    expectTypeOf<InboxMessage<Inbox<{ id: string }>>>().toEqualTypeOf<{
      id: string;
    }>();
  });
});
