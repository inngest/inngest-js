import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createClient } from "../../test/helpers.ts";
import { StepMode } from "../../types.ts";
import { addEventIs, eventType } from "./triggers.ts";
import type { EventIs } from "./typeHelpers.ts";

const a = eventType("a", { schema: z.object({ a: z.string() }) });
const b = eventType("b", { schema: z.object({ b: z.number() }) });
const c = eventType("c");

describe("EventType.is", () => {
  test("true for a value with the same name", () => {
    expect(a.is({ name: "a", data: { a: "x" } })).toBe(true);
  });

  test("false for a value with another name", () => {
    expect(a.is({ name: "b", data: { b: 1 } })).toBe(false);
  });

  test("false for values that are not events", () => {
    expect(a.is(null)).toBe(false);
    expect(a.is("a")).toBe(false);
    expect(a.is({})).toBe(false);
  });

  test("narrows plain JSON", () => {
    const value = { name: "a", data: { a: "x" } } as unknown;

    if (a.is(value)) {
      expectTypeOf(value.name).toEqualTypeOf<"a">();
      expectTypeOf(value.data).toEqualTypeOf<{ a: string }>();
    }
  });

  test("narrows a union of plain JSON", () => {
    const value = { name: "b", data: { b: 1 } } as
      | { name: "a"; data: { a: string } }
      | { name: "b"; data: { b: number } };

    if (b.is(value)) {
      expectTypeOf(value.data).toEqualTypeOf<{ b: number }>();
    }
  });
});

describe("is() with a wildcard type", () => {
  const user = eventType("user/*", { schema: z.object({ id: z.string() }) });
  const anyUser = eventType("user/*");

  const named = (name: string) => {
    return addEventIs({ name, data: {} }) as unknown as EventIs;
  };

  test("EventType.is is a type error, and never matches by prefix", () => {
    // @ts-expect-error a wildcard event type cannot be passed to is()
    expect(user.is({ name: "user/created", data: { id: "x" } })).toBe(false);

    // @ts-expect-error a wildcard event type cannot be passed to is()
    expect(anyUser.is({ name: "user/created", data: {} })).toBe(false);
  });

  test("event.is is a type error, and never matches by prefix", () => {
    // @ts-expect-error a wildcard event type cannot be passed to is()
    expect(named("user/created").is(user)).toBe(false);

    // @ts-expect-error one wildcard event type in a list is enough
    expect(named("user/created").is([a, anyUser])).toBe(false);
  });

  test("an exact type still matches by equality", () => {
    expect(a.is({ name: "a/b", data: {} })).toBe(false);
    expect(named("a").is([a, b])).toBe(true);
  });

  test("a handler's false branch keeps the other events", () => {
    const created = eventType("user/created", {
      schema: z.object({ id: z.string() }),
    });
    const other = eventType("other/created");

    createClient({ id: "test" }).createFunction(
      { id: "fn", triggers: [created, other] },
      ({ event }) => {
        // @ts-expect-error a wildcard event type cannot be passed to is()
        event.is(user);

        if (event.is(created)) {
          expectTypeOf(event.name).toEqualTypeOf<"user/created">();
        } else {
          expectTypeOf(event.name).toEqualTypeOf<
            "other/created" | "inngest/function.invoked"
          >();
        }
      },
    );
  });
});

describe("handler event.is", () => {
  async function runHandler(name: string, data: Record<string, unknown>) {
    const results: unknown[] = [];

    const fn = createClient({ id: "test" }).createFunction(
      { id: "fn", triggers: [a, b, c] },
      ({ event }) => {
        results.push(
          event.is(a),
          event.is(b),
          event.is([a, b]),
          event.is([b, c]),
        );

        if (event.is(a)) {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        } else if (event.is([b, c])) {
          expectTypeOf(event.name).toEqualTypeOf<"b" | "c">();
        }

        if (event.is(a)) {
          expectTypeOf(event.name).toEqualTypeOf<"a">();
        } else {
          expectTypeOf(event.name).toEqualTypeOf<
            "b" | "c" | "inngest/function.invoked"
          >();
        }

        if (event.is([a, b])) {
          expectTypeOf(event.name).toEqualTypeOf<"a" | "b">();
        } else {
          expectTypeOf(event.name).toEqualTypeOf<
            "c" | "inngest/function.invoked"
          >();
        }
      },
    );

    const execution = fn["createExecution"]({
      partialOptions: {
        client: fn["client"],
        data: fromPartial({ event: { name, data } }),
        runId: "run",
        stepState: {},
        stepCompletionOrder: [],
        reqArgs: [],
        headers: {},
        stepMode: StepMode.Async,
      },
    });

    await execution.start();

    return results;
  }

  test("one type", async () => {
    expect(await runHandler("a", { a: "x" })).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  test("many types", async () => {
    expect(await runHandler("c", {})).toEqual([false, false, false, true]);
  });

  test("does not change the serialised event", async () => {
    const fn = createClient({ id: "test" }).createFunction(
      { id: "fn", triggers: [a] },
      ({ event }) => {
        return event;
      },
    );

    const execution = fn["createExecution"]({
      partialOptions: {
        client: fn["client"],
        data: fromPartial({ event: { name: "a", data: { a: "x" } } }),
        runId: "run",
        stepState: {},
        stepCompletionOrder: [],
        reqArgs: [],
        headers: {},
        stepMode: StepMode.Async,
      },
    });

    const ret = await execution.start();

    expect(ret).toMatchObject({
      type: "function-resolved",
      data: { name: "a", data: { a: "x" } },
    });
    expect(JSON.parse(JSON.stringify((ret as { data: object }).data))).toEqual({
      name: "a",
      data: { a: "x" },
    });
  });
});
