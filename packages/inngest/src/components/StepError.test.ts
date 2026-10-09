import { describe, expect, test } from "vitest";
import { serializeError } from "../helpers/errors.ts";
import { StepError } from "./StepError.ts";

describe("StepError", () => {
  test("preserves the code property from a serialized error", () => {
    const original = Object.assign(new Error("boom"), {
      code: "my/error-code",
    });
    const serialized = serializeError(original);

    const received = new StepError("my-step", serialized);

    expect(received.code).toBe("my/error-code");
  });

  test("leaves code undefined when the error has none", () => {
    const serialized = serializeError(new Error("boom"));

    const received = new StepError("my-step", serialized);

    expect(received.code).toBeUndefined();
  });

  test("copies name, message and stepId", () => {
    const serialized = serializeError(new Error("boom"));

    const received = new StepError("my-step", serialized);

    expect(received.message).toBe("boom");
    expect(received.name).toBe("Error");
    expect(received.stepId).toBe("my-step");
  });
});
