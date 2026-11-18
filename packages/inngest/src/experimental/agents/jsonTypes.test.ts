/**
 * @module
 * Type tests: `Json` accepts nested JSON and rejects what JSON cannot carry,
 * `JsonSchema` is a record of `Json`, and the model's message type is
 * exported as `ModelMessage`.
 */
import type { Json, JsonSchema, ModelMessage } from "./index.ts";

class Point {
  x = 1;
}

describe("Json", () => {
  test("accepts nested JSON", () => {
    const value: Json = {
      a: [1, "two", true, null, { b: [[]] }],
      c: { d: null },
    };
    expectTypeOf(value).toExtend<Json>();
    expectTypeOf<string>().toExtend<Json>();
    expectTypeOf<number>().toExtend<Json>();
    expectTypeOf<boolean>().toExtend<Json>();
    expectTypeOf<null>().toExtend<Json>();
    expectTypeOf<Json[]>().toExtend<Json>();
    expectTypeOf<{ [key: string]: Json }>().toExtend<Json>();
  });

  test("rejects undefined, functions, Date and class instances", () => {
    expectTypeOf<undefined>().not.toExtend<Json>();
    expectTypeOf<() => void>().not.toExtend<Json>();
    expectTypeOf<Date>().not.toExtend<Json>();
    expectTypeOf<Point>().not.toExtend<Json>();
    expectTypeOf<{ a: undefined }>().not.toExtend<Json>();
  });

  test("JsonSchema is a record of Json", () => {
    expectTypeOf<JsonSchema>().toEqualTypeOf<{ [key: string]: Json }>();
  });
});

describe("ModelMessage", () => {
  test("is the loop's message union", () => {
    expectTypeOf<ModelMessage["role"]>().toEqualTypeOf<
      "user" | "assistant" | "tool"
    >();
  });
});
