import type { IsAny, IsEqual, IsUnknown } from "../helpers/types.ts";
import type { Jsonify } from "./jsonify.ts";

describe("Jsonify", () => {
  describe("unnested", () => {
    test("allows `any`", () => {
      // biome-ignore lint/suspicious/noExplicitAny: intentional
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
  });

  describe("nested", () => {
    test("allows `any`", () => {
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      type Actual = Jsonify<{ foo: any }>;
      // biome-ignore lint/suspicious/noExplicitAny: intentional
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
  });

  describe("#513", () => {
    test("appropriately types `string | null` when unnested", () => {
      type Actual = Jsonify<string | null>;
      type Expected = string | null;
      assertType<IsAny<Actual>>(false);
      assertType<IsEqual<Actual, Expected>>(true);
    });

    test("appropriately types `string | null` when nested", () => {
      type Actual = Jsonify<{ foo: string | null }>;
      type Expected = { foo: string | null };
      assertType<IsAny<Actual["foo"]>>(false);
      assertType<IsEqual<Actual, Expected>>(true);
    });
  });

  describe("#98", () => {
    test("allows mapped types with overrides when unnested", () => {
      interface Foo {
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        [x: string]: any;
        foo: boolean;
      }

      type Actual = Jsonify<Foo>;
      type Expected = {
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        [x: string]: any;
        foo: boolean;
      };

      assertType<IsEqual<Actual, Expected>>(true);
      assertType<IsEqual<Actual["foo"], boolean>>(true);
      assertType<IsAny<Actual["bar"]>>(true);
    });

    test("allows mapped types with overrides when nested", () => {
      interface Foo {
        // biome-ignore lint/suspicious/noExplicitAny: intentional
        [x: string]: any;
        foo: boolean;
      }

      type Actual = Jsonify<{ foo: Foo }>;
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      type Expected = { foo: { [x: string]: any; foo: boolean } };

      assertType<IsEqual<Actual, Expected>>(true);
      assertType<IsEqual<Actual["foo"]["foo"], boolean>>(true);
      assertType<IsAny<Actual["foo"]["bar"]>>(true);
    });
  });

  describe("#537", () => {
    describe("nested { name: string; } object is preserved", () => {
      test("when nullable", () => {
        type Actual = Jsonify<{
          profile: { name: string } | null;
        }>;
        type Expected = {
          profile: { name: string } | null;
        };

        assertType<IsEqual<Actual, Expected>>(true);
      });

      test("when union with another object", () => {
        type Actual = Jsonify<{
          profile: { name: string } | { age: number };
        }>;
        type Expected = {
          profile: { name: string } | { age: number };
        };

        assertType<IsEqual<Actual, Expected>>(true);
      });

      test("when union with another scalar", () => {
        type Actual = Jsonify<{
          profile: { name: string } | boolean;
        }>;
        type Expected = {
          profile: { name: string } | boolean;
        };

        assertType<IsEqual<Actual, Expected>>(true);
      });
    });
  });
});
