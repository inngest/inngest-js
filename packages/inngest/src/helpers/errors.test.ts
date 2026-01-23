import { isSerializedError, serializeError } from "./errors.ts";

interface ErrorTests {
  name: string;
  error: unknown;
  tests: {
    name?: string;
    message?: string;
  };
}

const testError = ({ name, error: errToTest, tests }: ErrorTests) => {
  describe(name, () => {
    const err = serializeError(errToTest);

    if (tests.name) {
      it("should have a name", () => {
        expect(err.name).toBe(tests.name ?? "Error");
      });
    }

    if (tests.message) {
      it("should have a message", () => {
        expect(err.message).toBe(tests.message);
      });
    }

    it("should have a stack", () => {
      expect(err.stack).toBeDefined();
    });

    it("should be detected as a serialized error", () => {
      expect(isSerializedError(err)).toBeDefined();
    });
  });
};

class CustomError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "CustomError";
  }
}

describe("serializeError", () => {
  testError({
    name: "string",
    error: "test",
    tests: { message: "test" },
  });

  testError({
    name: "number",
    error: 1,
    tests: { message: "1" },
  });

  testError({
    name: "boolean",
    error: true,
    tests: { message: "true" },
  });

  testError({
    name: "null",
    error: null,
    tests: { message: "null" },
  });

  testError({
    name: "undefined",
    error: undefined,
    tests: { message: "{}" },
  });

  testError({
    name: "object",
    error: { foo: "bar" },
    tests: { message: '{"foo":"bar"}' },
  });

  testError({
    name: "array",
    error: [],
    tests: { message: "[]" },
  });

  testError({
    name: "Blank error",
    error: new Error(),
    tests: { message: "{}" },
  });

  testError({
    name: "Custom error",
    error: new CustomError("test"),
    tests: { name: "CustomError", message: "test" },
  });

  testError({
    name: "Existing serialized error",
    error: serializeError(new Error("test")),
    tests: { message: "test" },
  });
});
