import { stepsSchema } from "./schema";

describe("stepsSchema", () => {
  test("handles v1 { data } objects", () => {
    const expected = {
      id: {
        type: "data",
        data: "something",
      },
    };

    const actual = stepsSchema.safeParse({
      id: {
        data: "something",
      },
    });

    expect(actual.success).toBe(true);
    expect(actual.success && actual.data).toEqual(expected);
  });

  test("handles v1 { error } objects", () => {
    const expected = {
      id: {
        type: "error",
        error: {
          name: "Error",
          message: "something",
        },
      },
    };

    const actual = stepsSchema.safeParse({
      id: {
        error: {
          name: "Error",
          message: "something",
        },
      },
    });

    expect(actual.success).toBe(true);
    expect(actual.success && actual.data).toEqual(expected);
  });
  test("handles null from a v0 or v1 sleep or waitForEvent", () => {
    const expected = {
      id: {
        type: "data",
        data: null,
      },
    };

    const actual = stepsSchema.safeParse({
      id: null,
    });

    expect(actual.success).toBe(true);
    expect(actual.success && actual.data).toEqual(expected);
  });

  test("handles event from v0 or v1 waitForEvent", () => {
    const expected = {
      id: {
        type: "data",
        data: {
          name: "event",
          data: { some: "data" },
          ts: 123,
        },
      },
    };

    const actual = stepsSchema.safeParse({
      id: {
        name: "event",
        data: { some: "data" },
        ts: 123,
      },
    });

    expect(actual.success).toBe(true);
    expect(actual.success && actual.data).toEqual(expected);
  });
});
