/**
 * @module
 * Type tests for how `step.subscribe()` types the messages of an
 * inbox from its sources.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createClient } from "../../test/helpers.ts";
import { eventType } from "../triggers/triggers.ts";
import type { InboxMessage } from "./Inbox.ts";

const review = eventType("review", {
  schema: z.object({ state: z.string() }),
});
const comment = eventType("comment", {
  schema: z.object({ body: z.string() }),
});
const push = eventType("push", { schema: z.object({ sha: z.string() }) });

const fn = createClient({ id: "test" }).createFunction(
  { id: "fn", triggers: [push] },
  async ({ step }) => {
    // One event type.
    await using one = step.subscribe("one", review);
    const r = (await one.next())!;
    expectTypeOf(r.name).toEqualTypeOf<"review">();
    expectTypeOf(r.data).toEqualTypeOf<{ state: string }>();

    // Several, one with an if.
    await using many = step.subscribe("many", [
      review,
      { event: comment, if: "async.data.body != ''" },
    ]);
    const m = (await many.next())!;
    expectTypeOf(m.name).toEqualTypeOf<"review" | "comment">();

    if (m.is(review)) {
      expectTypeOf(m.data).toEqualTypeOf<{ state: string }>();
    } else {
      expectTypeOf(m.name).toEqualTypeOf<"comment">();
      expectTypeOf(m.data).toEqualTypeOf<{ body: string }>();
    }

    expectTypeOf(await many.drain()).toEqualTypeOf<(typeof m)[]>();

    // A name string has no schema: its messages are the default, deliberately
    // unknown.
    await using named = step.subscribe("named", "review");
    const n = (await named.next())!;
    expectTypeOf(n).toEqualTypeOf<InboxMessage>();
    expectTypeOf(n.data).toBeUnknown();

    // Two inboxes in one function are typed apart, each from its own sources.
    await using pushes = step.subscribe("pushes", push);
    const p = (await pushes.next())!;
    expectTypeOf(p.name).toEqualTypeOf<"push">();
    expectTypeOf(p.data).toEqualTypeOf<{ sha: string }>();
    expectTypeOf((await one.next())!.name).toEqualTypeOf<"review">();

    await using mixed = step.subscribe("mixed", [review, "other"]);
    const x = (await mixed.next())!;
    expectTypeOf(x.name).toEqualTypeOf<string>();
  },
);

describe("inbox source types", () => {
  test("compile", () => {
    expect(fn).toBeDefined();
  });
});
