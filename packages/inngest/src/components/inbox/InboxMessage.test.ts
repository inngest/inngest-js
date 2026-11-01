/**
 * @module
 * Type tests for `InboxMessage`, which names what an inbox reads, and the types
 * the package root exports so declaration files can name inbox types.
 */
import { expectTypeOf } from "vitest";
import { z } from "zod";
import type {
  Inbox,
  InboxMessage,
  InboxMessageOf,
  UntypedInboxMessage,
} from "../../index.ts";
import { eventType } from "../triggers/triggers.ts";

const review = eventType("review", {
  schema: z.object({ state: z.string() }),
});

describe("InboxMessage", () => {
  test("is the message type of an inbox", () => {
    expectTypeOf<InboxMessage<Inbox>>().toEqualTypeOf<InboxMessage>();
    expectTypeOf<InboxMessage<Inbox<{ id: string }>>>().toEqualTypeOf<{
      id: string;
    }>();
  });

  test("bare InboxMessage is the untyped message", () => {
    expectTypeOf<InboxMessage>().toEqualTypeOf<UntypedInboxMessage>();
    expectTypeOf<UntypedInboxMessage["data"]>().toBeUnknown();
  });

  test("InboxMessageOf is the message of the sources", () => {
    expectTypeOf<InboxMessageOf<"review">>().toEqualTypeOf<InboxMessage>();
    expectTypeOf<
      InboxMessageOf<typeof review>["name"]
    >().toEqualTypeOf<"review">();
  });
});
