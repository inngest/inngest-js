import { NonRetriableError } from "../components/NonRetriableError.ts";
import {
  deserializeError,
  isSerializedError,
  serializeError,
} from "./errors.ts";

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

class MyCustomError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "MyCustomError";
  }
}

describe("serializeError -> deserializeError round trip", () => {
  it("round-trips a NonRetriableError", () => {
    const err = deserializeError(serializeError(new NonRetriableError("boom")));

    expect(err.name).toBe("NonRetriableError");
    expect(err.message).toBe("boom");
    expect(err).toBeInstanceOf(NonRetriableError);
  });

  it("round-trips a built-in TypeError", () => {
    const err = deserializeError(serializeError(new TypeError("bad")));

    expect(err.name).toBe("TypeError");
    expect(err).toBeInstanceOf(TypeError);
  });

  it("round-trips a plain Error", () => {
    const err = deserializeError(serializeError(new Error("plain")));

    expect(err.name).toBe("Error");
    expect(err.message).toBe("plain");
  });

  it("preserves a cause through the round trip", () => {
    const err = deserializeError(
      serializeError(
        new NonRetriableError("outer", { cause: new Error("inner") }),
      ),
    );

    expect(err.cause).toMatchObject({ message: "inner" });
  });

  it("falls back to a plain Error for an unknown custom error name", () => {
    const err = deserializeError(serializeError(new MyCustomError("custom")));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("custom");
  });

  it("recognizes a stringified serialized error instead of double-wrapping", () => {
    const str = JSON.stringify(serializeError(new Error("stringified")));

    const err = deserializeError(serializeError(str));

    expect(err.name).toBe("Error");
    expect(err.message).toBe("stringified");
  });

  it("preserves a code through the round trip", () => {
    const original = Object.assign(new Error("with code"), { code: "E_TEST" });

    const err = deserializeError(serializeError(original));

    expect(err).toMatchObject({ message: "with code", code: "E_TEST" });
  });
});
