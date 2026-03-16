import { stepSchema } from "./schema.ts";

describe("stepSchema", () => {
  test("handles { data } objects", () => {
    const expected = {
      id: {
        type: "data",
        data: "something",
      },
    };

    const actual = stepSchema.safeParse({
      id: {
        data: "something",
      },
    });

    expect(actual.success).toBe(true);
    expect(actual.success && actual.data).toEqual(expected);
  });

  test("handles { error } objects", () => {
    const expected = {
      id: {
        type: "error",
        error: {
          name: "Error",
          message: "something",
        },
      },
    };

    const actual = stepSchema.safeParse({
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

  test("handles null from a sleep or waitForEvent", () => {
    const expected = {
      id: {
        type: "data",
        data: null,
      },
    };

    const actual = stepSchema.safeParse({
      id: null,
    });

    expect(actual.success).toBe(true);
    expect(actual.success && actual.data).toEqual(expected);
  });

  test("handles event from waitForEvent", () => {
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

    const actual = stepSchema.safeParse({
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
