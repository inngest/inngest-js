import { z } from "zod";
import type { IsAny, IsEqual } from "../helpers/types.ts";
import type { MinimalEventPayload } from "../types";
import { EventSchemas } from "./EventSchemas";
import { Inngest } from "./Inngest.ts";
import {
  InngestFunctionReference,
  referenceFunction,
} from "./InngestFunctionReference.ts";

describe("referenceFunction", () => {
  describe("basic functionality", () => {
    test("creates a function reference with just functionId", () => {
      const fnRef = referenceFunction({
        functionId: "test-function",
      });

      expect(fnRef).toBeInstanceOf(InngestFunctionReference);
      expect(fnRef.opts.functionId).toBe("test-function");
      expect(fnRef.opts.appId).toBeUndefined();

      // Type assertions
      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;
      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);
      assertType<IsEqual<ActualInput, MinimalEventPayload>>(true);
      assertType<IsEqual<ActualOutput, unknown>>(true);
    });

    test("creates a function reference with functionId and appId", () => {
      const fnRef = referenceFunction({
        functionId: "test-function",
        appId: "test-app",
      });

      expect(fnRef).toBeInstanceOf(InngestFunctionReference);
      expect(fnRef.opts.functionId).toBe("test-function");
      expect(fnRef.opts.appId).toBe("test-app");

      // Type assertions - should still default to MinimalEventPayload/unknown without schemas
      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;
      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);
      assertType<IsEqual<ActualInput, MinimalEventPayload>>(true);
      assertType<IsEqual<ActualOutput, unknown>>(true);
    });

    test("creates a function reference with schemas", () => {
      const fnRef = referenceFunction({
        functionId: "test-function",
        schemas: {
          data: z.object({ value: z.number() }),
          return: z.object({ result: z.string() }),
        },
      });

      expect(fnRef).toBeInstanceOf(InngestFunctionReference);
      expect(fnRef.opts.functionId).toBe("test-function");
      expect(fnRef.opts.appId).toBeUndefined();

      // Type assertions - should infer types from schemas
      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;
      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);

      // Input should have data field with the schema type
      type InputData = ActualInput["data"];
      assertType<IsAny<InputData>>(false);
      assertType<IsEqual<InputData, { value: number }>>(true);

      // Output should match return schema
      assertType<IsEqual<ActualOutput, { result: string }>>(true);
    });

    test("creates a function reference with all parameters", () => {
      const fnRef = referenceFunction({
        functionId: "test-function",
        appId: "test-app",
        schemas: {
          data: z.object({ value: z.number() }),
          return: z.object({ result: z.string() }),
        },
      });

      expect(fnRef).toBeInstanceOf(InngestFunctionReference);
      expect(fnRef.opts.functionId).toBe("test-function");
      expect(fnRef.opts.appId).toBe("test-app");

      // Type assertions - schemas should work regardless of appId
      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;
      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);

      // Input should have data field with the schema type
      type InputData = ActualInput["data"];
      assertType<IsAny<InputData>>(false);
      assertType<IsEqual<InputData, { value: number }>>(true);

      // Output should match return schema
      assertType<IsEqual<ActualOutput, { result: string }>>(true);
    });
  });

  describe("type inference", () => {
    test("infers unknown types when no schemas are provided", () => {
      const fnRef = referenceFunction({
        functionId: "test-function",
      });

      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;

      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      // Check that types are not any
      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);

      // Without schemas, input should be MinimalEventPayload
      assertType<IsEqual<ActualInput, MinimalEventPayload>>(true);
      // Without schemas, output should be unknown
      assertType<IsEqual<ActualOutput, unknown>>(true);
    });

    test("infers correct types from Zod schemas", () => {
      const dataSchema = z.object({ value: z.number() });
      const returnSchema = z.object({ result: z.string() });

      const fnRef = referenceFunction({
        functionId: "test-function",
        schemas: {
          data: dataSchema,
          return: returnSchema,
        },
      });

      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;

      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      // Check that types are not any
      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);

      // Input should include the required data field with the correct schema
      type InputData = ActualInput["data"];
      assertType<IsAny<InputData>>(false);
      assertType<IsEqual<InputData, { value: number }>>(true);

      // Output should match the return schema
      assertType<IsEqual<ActualOutput, { result: string }>>(true);
    });

    test("infers types from an InngestFunction passed as generic", () => {
      const inngest = new Inngest({
        id: "test",
        schemas: new EventSchemas().fromSchema({
          "test/event": z.object({ someValue: z.string() }),
        }),
      });

      // Create a test function to reference
      const testFunction = inngest.createFunction(
        { id: "test-function" },
        { event: "test/event" },
        async ({ event }) => {
          return { success: true, value: event.data.someValue };
        },
      );

      // Reference the function by passing it as a generic
      const fnRef = referenceFunction<typeof testFunction>({
        functionId: "test-function",
      });

      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;

      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      // Check that types are not any
      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);

      // The types should be properly inferred from the function
      // Input should have the event structure
      assertType<IsEqual<ActualInput["data"], { someValue: string }>>(true);

      // Output should match the function's return type
      type ExpectedOutput = { success: boolean; value: string };
      assertType<IsEqual<ActualOutput, ExpectedOutput>>(true);
    });

    test("handles optional data schema correctly", () => {
      const fnRef = referenceFunction({
        functionId: "test-function",
        schemas: {
          return: z.object({ result: z.string() }),
        },
      });

      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      // Check that output type is not any
      assertType<IsAny<ActualOutput>>(false);
      assertType<IsEqual<ActualOutput, { result: string }>>(true);
    });

    test("handles optional return schema correctly", () => {
      const fnRef = referenceFunction({
        functionId: "test-function",
        schemas: {
          data: z.object({ value: z.number() }),
        },
      });

      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;

      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      // Check that types are not any
      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);

      // Input data should match the schema
      type InputData = ActualInput["data"];
      assertType<IsAny<InputData>>(false);
      assertType<IsEqual<InputData, { value: number }>>(true);

      // Output should be unknown when not provided
      assertType<IsEqual<ActualOutput, unknown>>(true);
    });
  });

  describe("cross-app references", () => {
    test("creates reference for same-app function without appId", () => {
      const fnRef = referenceFunction({
        functionId: "local-function",
      });

      expect(fnRef.opts.appId).toBeUndefined();
      // When appId is not provided, it should be treated as a local function

      // Type assertions - appId doesn't affect type inference
      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;

      assertType<IsAny<ActualInput>>(false);
      assertType<IsEqual<ActualInput, MinimalEventPayload>>(true);
    });

    test("creates reference for cross-app function with appId", () => {
      const fnRef = referenceFunction({
        functionId: "remote-function",
        appId: "another-app",
      });

      expect(fnRef.opts.appId).toBe("another-app");
      // When appId is provided, it should be treated as a cross-app reference

      // Type assertions - cross-app references still default to MinimalEventPayload/unknown
      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;
      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);
      assertType<IsEqual<ActualInput, MinimalEventPayload>>(true);
      assertType<IsEqual<ActualOutput, unknown>>(true);
    });
  });

  describe("edge cases", () => {
    test("handles empty string functionId", () => {
      const fnRef = referenceFunction({
        functionId: "",
      });

      expect(fnRef).toBeInstanceOf(InngestFunctionReference);
      expect(fnRef.opts.functionId).toBe("");
    });

    test("handles empty string appId", () => {
      const fnRef = referenceFunction({
        functionId: "test-function",
        appId: "",
      });

      expect(fnRef).toBeInstanceOf(InngestFunctionReference);
      expect(fnRef.opts.appId).toBe("");
    });

    test("handles complex Zod schemas", () => {
      const complexDataSchema = z.object({
        nested: z.object({
          value: z.number(),
          array: z.array(z.string()),
        }),
        optional: z.string().optional(),
        union: z.union([z.literal("a"), z.literal("b")]),
      });

      const complexReturnSchema = z.discriminatedUnion("type", [
        z.object({ type: z.literal("success"), data: z.any() }),
        z.object({ type: z.literal("error"), message: z.string() }),
      ]);

      const fnRef = referenceFunction({
        functionId: "complex-function",
        schemas: {
          data: complexDataSchema,
          return: complexReturnSchema,
        },
      });

      expect(fnRef).toBeInstanceOf(InngestFunctionReference);

      // Type assertions - complex schemas should be correctly resolved
      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;
      type ActualOutput = typeof fnRef extends InngestFunctionReference<
        infer _,
        infer TOutput
      >
        ? TOutput
        : never;

      assertType<IsAny<ActualInput>>(false);
      assertType<IsAny<ActualOutput>>(false);

      // Input data should match complex schema
      type InputData = ActualInput["data"];
      assertType<IsAny<InputData>>(false);
      type ExpectedInputData = {
        nested: {
          value: number;
          array: string[];
        };
        optional?: string;
        union: "a" | "b";
      };
      assertType<IsEqual<InputData, ExpectedInputData>>(true);

      // Output should be a discriminated union
      type ExpectedOutput =
        // biome-ignore lint/suspicious/noExplicitAny: z.any() returns any type
        { type: "success"; data?: any } | { type: "error"; message: string };
      assertType<IsEqual<ActualOutput, ExpectedOutput>>(true);
    });

    test("handles schemas with transforms", () => {
      const transformSchema = z.object({
        date: z.string().transform((val) => new Date(val)),
        number: z.string().transform((val) => parseInt(val, 10)),
      });

      const fnRef = referenceFunction({
        functionId: "transform-function",
        schemas: {
          data: transformSchema,
        },
      });

      expect(fnRef).toBeInstanceOf(InngestFunctionReference);

      // Type assertions - transforms should resolve to output types
      type ActualInput = typeof fnRef extends InngestFunctionReference<
        infer TInput,
        infer _
      >
        ? TInput
        : never;

      assertType<IsAny<ActualInput>>(false);

      // Input data should have the transformed types
      type InputData = ActualInput["data"];
      assertType<IsAny<InputData>>(false);
      type ExpectedInputData = {
        date: Date;
        number: number;
      };
      assertType<IsEqual<InputData, ExpectedInputData>>(true);
    });
  });

  describe("namespace types", () => {
    test("InngestFunctionReference.Any matches any reference", () => {
      const fnRef1 = referenceFunction({
        functionId: "test1",
      });

      const fnRef2 = referenceFunction({
        functionId: "test2",
        schemas: {
          data: z.object({ value: z.number() }),
        },
      });

      // Both should be assignable to InngestFunctionReference.Any
      const any1: InngestFunctionReference.Any = fnRef1;
      const any2: InngestFunctionReference.Any = fnRef2;

      expect(any1).toBeInstanceOf(InngestFunctionReference);
      expect(any2).toBeInstanceOf(InngestFunctionReference);

      // Type assertion - verify that Any type accepts different reference types
      type IsAssignable1 = typeof fnRef1 extends InngestFunctionReference.Any
        ? true
        : false;
      type IsAssignable2 = typeof fnRef2 extends InngestFunctionReference.Any
        ? true
        : false;

      assertType<IsAssignable1>(true);
      assertType<IsAssignable2>(true);
    });

    test("HelperArgs type structure", () => {
      // Test that the type accepts the expected shape
      type TestArgs = InngestFunctionReference.HelperArgs<
        z.ZodType<{ value: number }>,
        z.ZodType<{ result: string }>
      >;

      const args: TestArgs = {
        functionId: "test",
        appId: "app",
        schemas: {
          data: z.object({ value: z.number() }),
          return: z.object({ result: z.string() }),
        },
      };

      expect(args.functionId).toBe("test");
    });

    test("InngestFunctionReference.Like type for duck typing", () => {
      // The Like interface uses Symbol.toStringTag for structural typing
      // This allows checking if something "looks like" a function reference

      // Create actual function references
      const basicRef = referenceFunction({
        functionId: "basic-function",
      });

      const typedRef = referenceFunction({
        functionId: "typed-function",
        schemas: {
          data: z.object({ value: z.number() }),
          return: z.object({ result: z.string() }),
        },
      });

      // Create a mock object that satisfies the Like interface
      const mockLikeRef: InngestFunctionReference.Like = {
        [Symbol.toStringTag]: InngestFunctionReference.Tag,
      };

      // Test that actual references DO extend Like
      // (now that the class has the Symbol.toStringTag getter)
      type BasicExtendsLike =
        typeof basicRef extends InngestFunctionReference.Like ? true : false;
      type TypedExtendsLike =
        typeof typedRef extends InngestFunctionReference.Like ? true : false;

      // These should be true because InngestFunctionReference class
      // now has Symbol.toStringTag property via getter
      assertType<BasicExtendsLike>(true);
      assertType<TypedExtendsLike>(true);

      // Test that the mock object satisfies Like
      type MockSatisfiesLike =
        typeof mockLikeRef extends InngestFunctionReference.Like ? true : false;
      assertType<MockSatisfiesLike>(true);

      // Test that Like can be used as a type guard pattern
      function acceptsLike(ref: InngestFunctionReference.Like) {
        return ref[Symbol.toStringTag];
      }

      // This should work with the mock
      expect(acceptsLike(mockLikeRef)).toBe("Inngest.FunctionReference");

      // This should also work with actual references now
      expect(acceptsLike(basicRef)).toBe("Inngest.FunctionReference");
      expect(acceptsLike(typedRef)).toBe("Inngest.FunctionReference");

      // Runtime checks for actual references
      expect(basicRef).toBeInstanceOf(InngestFunctionReference);
      expect(typedRef).toBeInstanceOf(InngestFunctionReference);

      // Verify Symbol.toStringTag is properly set
      expect(basicRef[Symbol.toStringTag]).toBe("Inngest.FunctionReference");
      expect(typedRef[Symbol.toStringTag]).toBe("Inngest.FunctionReference");
    });
  });
});
