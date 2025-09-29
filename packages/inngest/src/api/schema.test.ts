import { ExecutionVersion } from "../helpers/consts.ts";
import { stepsSchemas } from "./schema.ts";

describe("stepsSchemas", () => {
  describe("v0", () => {
    const schema = stepsSchemas[ExecutionVersion.V0];

    test("handles any data", () => {
      const expected = {
        id: "something",
        id2: "something else",
        id3: true,
        id4: { data: false },
      };

      const actual = schema.safeParse({
        id: "something",
        id2: "something else",
        id3: true,
        id4: { data: false },
      });

      expect(actual.success).toBe(true);
      expect(actual.success && actual.data).toEqual(expected);
    });

    test("throws if finding undefined value", () => {
      const result = schema.safeParse({
        id: "something",
        id2: undefined,
      });

      expect(result.success).toBe(false);
    });
  });

  describe("v1", () => {
    const schema = stepsSchemas[ExecutionVersion.V1];

    test("handles v1 { data } objects", () => {
      const expected = {
        id: {
          type: "data",
          data: "something",
        },
      };

      const actual = schema.safeParse({
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

      const actual = schema.safeParse({
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

      const actual = schema.safeParse({
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

      const actual = schema.safeParse({
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
});
