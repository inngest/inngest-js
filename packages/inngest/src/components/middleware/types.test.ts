import { describe, expectTypeOf, test } from "vitest";
import type { ExtractLiteralStrings, OpenStringUnion } from "./types.ts";

describe("OpenStringUnion", () => {
  test("accepts known literal members", () => {
    type Color = OpenStringUnion<"red" | "green" | "blue">;
    expectTypeOf<"red">().toExtend<Color>();
    expectTypeOf<"green">().toExtend<Color>();
    expectTypeOf<"blue">().toExtend<Color>();
  });

  test("accepts arbitrary strings", () => {
    type Color = OpenStringUnion<"red" | "green" | "blue">;
    expectTypeOf<"purple">().toExtend<Color>();
    expectTypeOf<string>().toExtend<Color>();
  });

  test("does not accept non-strings", () => {
    type Color = OpenStringUnion<"red" | "green">;
    expectTypeOf<number>().not.toExtend<Color>();
    expectTypeOf<boolean>().not.toExtend<Color>();
    expectTypeOf<{ foo: string }>().not.toExtend<Color>();
  });
});

describe("ExtractLiteralStrings", () => {
  test("extracts known literals from an open union", () => {
    type Color = OpenStringUnion<"red" | "green" | "blue">;
    type Extracted = ExtractLiteralStrings<Color>;
    expectTypeOf<Extracted>().toEqualTypeOf<"red" | "green" | "blue">();
  });

  test("returns never for plain string", () => {
    type Extracted = ExtractLiteralStrings<string>;
    expectTypeOf<Extracted>().toBeNever();
  });

  test("returns never for string & {}", () => {
    type Extracted = ExtractLiteralStrings<string & {}>;
    expectTypeOf<Extracted>().toBeNever();
  });

  test("extracts literals mixed with string & {}", () => {
    type Mixed = "a" | "b" | (string & {});
    type Extracted = ExtractLiteralStrings<Mixed>;
    expectTypeOf<Extracted>().toEqualTypeOf<"a" | "b">();
  });
});
