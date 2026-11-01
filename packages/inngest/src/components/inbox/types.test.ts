/**
 * @module
 * Type tests for the public types of `Inbox`: no `any`, and `unknown` only
 * where the user has not yet proved what the data is.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { eventType } from "../triggers/triggers.ts";
import type { EventIs } from "../triggers/typeHelpers.ts";
import type { Inbox, InboxMessage } from "./Inbox.ts";

const review = eventType("review", {
  schema: z.object({ state: z.string() }),
});
const comment = eventType("comment", {
  schema: z.object({ body: z.string() }),
});

type Reviews = { name: "review"; data: { state: string } };
type Comments = { name: "comment"; data: { body: string } };

declare const inbox: Inbox;

/**
 * The checks run only at compile time; the function is never called.
 */
const checks = async () => {
  // Reads on the default inbox: messages are InboxMessage.
  expectTypeOf(await inbox.next()).toEqualTypeOf<InboxMessage | undefined>();
  expectTypeOf(await inbox.next({ timeout: "1s" })).toEqualTypeOf<
    InboxMessage | null | undefined
  >();
  expectTypeOf(await inbox.nextBatch()).toEqualTypeOf<
    InboxMessage[] | undefined
  >();
  expectTypeOf(await inbox.nextBatch({ max: 2 })).toEqualTypeOf<
    InboxMessage[] | undefined
  >();
  expectTypeOf(await inbox.nextBatch({ timeout: 100 })).toEqualTypeOf<
    InboxMessage[] | null | undefined
  >();
  expectTypeOf(await inbox.nextBatch({ max: 2, timeout: 100 })).toEqualTypeOf<
    InboxMessage[] | null | undefined
  >();
  expectTypeOf(await inbox.drain()).toEqualTypeOf<InboxMessage[]>();
  expectTypeOf(await inbox.drain({ max: 2 })).toEqualTypeOf<InboxMessage[]>();
  expectTypeOf(await inbox.close()).toEqualTypeOf<InboxMessage[]>();
  expectTypeOf(inbox.closed).toEqualTypeOf<boolean>();

  for await (const m of inbox) {
    expectTypeOf(m).toEqualTypeOf<InboxMessage>();
  }

  for await (const batch of inbox.batches({ max: 2 })) {
    expectTypeOf(batch).toEqualTypeOf<InboxMessage[]>();
  }

  for await (const batch of inbox.batches({ max: 2, timeout: "1s" })) {
    expectTypeOf(batch).toEqualTypeOf<InboxMessage[]>();
  }

  // The message is not any, and its data is unknown until proved.
  const m = (await inbox.next())!;
  expectTypeOf(m).not.toBeAny();
  expectTypeOf(m.data).toBeUnknown();
  expectTypeOf(m.name).toEqualTypeOf<string>();
  expectTypeOf(m.is).toBeFunction();

  // m.is(type) narrows both ways.
  if (m.is(review)) {
    expectTypeOf(m.name).toEqualTypeOf<"review">();
    expectTypeOf(m.data).toEqualTypeOf<{ state: string }>();
  } else {
    expectTypeOf(m.data).toBeUnknown();
  }

  if (m.is([review, comment])) {
    expectTypeOf(m.name).toEqualTypeOf<"review" | "comment">();
    expectTypeOf(m.data).toEqualTypeOf<{ state: string } | { body: string }>();
  }

  // type.is(m) narrows both ways.
  if (review.is(m)) {
    expectTypeOf(m.name).toEqualTypeOf<"review">();
    expectTypeOf(m.data).toEqualTypeOf<{ state: string }>();
  } else {
    expectTypeOf(m.data).toBeUnknown();
  }

  // Views are typed from the event types they read.
  const reviews = inbox.of(review);
  expectTypeOf(await reviews.next()).toMatchTypeOf<
    (Reviews & EventIs) | undefined
  >();
  const one = (await reviews.next())!;
  expectTypeOf(one.name).toEqualTypeOf<"review">();
  expectTypeOf(one.data).toEqualTypeOf<{ state: string }>();
  expectTypeOf(one.data).not.toBeAny();

  const timed = await reviews.next({ timeout: "1s" });
  expectTypeOf(timed).toEqualTypeOf<typeof one | null | undefined>();

  const batch = await reviews.nextBatch({ max: 3 });
  expectTypeOf(batch).toEqualTypeOf<(typeof one)[] | undefined>();
  expectTypeOf(await reviews.drain()).toEqualTypeOf<(typeof one)[]>();
  expectTypeOf(await reviews.close()).toEqualTypeOf<(typeof one)[]>();

  const both = inbox.of([review, comment]);
  const either = (await both.next())!;
  expectTypeOf(either.name).toEqualTypeOf<"review" | "comment">();

  if (either.is(review)) {
    expectTypeOf(either.data).toEqualTypeOf<Reviews["data"]>();
  } else {
    expectTypeOf(either.name).toEqualTypeOf<"comment">();
    expectTypeOf(either.data).toEqualTypeOf<Comments["data"]>();
  }

  if (!comment.is(either)) {
    expectTypeOf(either.name).toEqualTypeOf<"review">();
  }

  // listen() is typed from its own sources; a name has no schema.
  const listened = inbox.listen("review");
  expectTypeOf(await listened.next()).toEqualTypeOf<InboxMessage | undefined>();

  // Not public: a name alone, and opened().
  // @ts-expect-error a view is typed from event types, not a name
  inbox.of("review");
  // @ts-expect-error opened() is internal
  inbox.opened();
};

describe("Inbox public types", () => {
  test("compile", () => {
    expect(checks).toBeTypeOf("function");
  });
});
