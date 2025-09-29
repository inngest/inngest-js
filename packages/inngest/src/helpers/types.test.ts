import type { IsEqual, RecursiveTuple } from "./types.ts";

describe("RecursiveTuple", () => {
  test("should create a tuple of length 1", () => {
    type Expected = [string];
    type Actual = RecursiveTuple<string, 1>;
    assertType<IsEqual<Expected, Actual>>(true);
  });

  test("should create a tuple of length 2", () => {
    type Expected = [string] | [string, string];
    type Actual = RecursiveTuple<string, 2>;
    assertType<IsEqual<Expected, Actual>>(true);
  });

  test("should create a tuple of length 3", () => {
    type Expected = [string] | [string, string] | [string, string, string];
    type Actual = RecursiveTuple<string, 3>;
    assertType<IsEqual<Expected, Actual>>(true);
  });

  test("should create a tuple with mixed primitives", () => {
    type Expected = [string | number] | [string | number, string | number];
    type Actual = RecursiveTuple<string | number, 2>;
    assertType<IsEqual<Expected, Actual>>(true);
  });

  test("should expand type aliases of primitives", () => {
    type T0 = string;
    type Expected = [string] | [string, string];
    type Actual = RecursiveTuple<T0, 2>;
    assertType<IsEqual<Expected, Actual>>(true);
  });
});
