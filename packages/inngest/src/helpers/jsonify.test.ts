/* eslint-disable @typescript-eslint/no-explicit-any */
import { type Jsonify } from "@local/helpers/jsonify";
import { type IsAny, type IsEqual, type IsUnknown } from "@local/helpers/types";
import { assertType } from "../test/helpers";

describe("Jsonify", () => {
  test("allows `any`", () => {
    type Actual = Jsonify<any>;
    assertType<IsAny<Actual>>(true);
  });

  test("allows `unknown`", () => {
    type Actual = Jsonify<unknown>;
    assertType<IsUnknown<Actual>>(true);
  });

  test("allows number literals", () => {
    type Actual = Jsonify<1>;
    type Expected = 1;
    assertType<IsEqual<Actual, Expected>>(true);
  });

  test("allows string literals", () => {
    type Actual = Jsonify<"foo">;
    type Expected = "foo";
    assertType<IsEqual<Actual, Expected>>(true);
  });

  test("#513 appropriately types `string | null`", () => {
    type Actual = Jsonify<string | null>;
    type Expected = string | null;
    assertType<IsAny<Actual>>(false);
    assertType<IsEqual<Actual, Expected>>(true);
  });

  describe("object", () => {
    test("allows `any`", () => {
      type Actual = Jsonify<{ foo: any }>;
      type Expected = { foo: any };
      assertType<IsEqual<Actual, Expected>>(true);
    });

    test("allows `unknown`", () => {
      type Actual = Jsonify<{ foo: unknown }>;
      type Expected = { foo: unknown };
      assertType<IsEqual<Actual, Expected>>(true);
    });

    test("allows number literals", () => {
      type Actual = Jsonify<{ foo: 1 }>;
      type Expected = { foo: 1 };
      assertType<IsEqual<Actual, Expected>>(true);
    });

    test("allows string literals", () => {
      type Actual = Jsonify<{ foo: "bar" }>;
      type Expected = { foo: "bar" };
      assertType<IsEqual<Actual, Expected>>(true);
    });

    test("#513 appropriately types `string | null`", () => {
      type Actual = Jsonify<{ foo: string | null }>;
      type Expected = { foo: string | null };
      assertType<IsAny<Actual["foo"]>>(false);
      assertType<IsEqual<Actual, Expected>>(true);
    });
  });
});
