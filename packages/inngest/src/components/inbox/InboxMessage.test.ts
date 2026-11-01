/**
 * @module
 * Type tests for `InboxMessage`, which names what an inbox reads.
 */
import { expectTypeOf } from "vitest";
import type { Inbox, InboxMessage } from "../../index.ts";

describe("InboxMessage", () => {
  test("is the message type of an inbox", () => {
    expectTypeOf<InboxMessage<Inbox>>().toEqualTypeOf<InboxMessage>();
    expectTypeOf<InboxMessage<Inbox<{ id: string }>>>().toEqualTypeOf<{
      id: string;
    }>();
  });
});
