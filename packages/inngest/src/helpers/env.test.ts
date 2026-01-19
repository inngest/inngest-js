import { parseAsBoolean } from "./env.ts";

describe("parseAsBoolean", () => {
  const specs: { input: unknown; expected: boolean | undefined }[] = [
    // Truthy boolean strings
    { input: "true", expected: true },
    { input: "TRUE", expected: true },
    { input: "1", expected: true },

    // Falsy boolean strings
    { input: "false", expected: false },
    { input: "FALSE", expected: false },
    { input: "0", expected: false },

    // Non-boolean strings should return undefined (not false!)
    { input: "http://localhost:3000", expected: undefined },
    { input: "0.0.0.0:8288", expected: undefined },
    { input: "localhost:9000", expected: undefined },
    { input: "random string", expected: undefined },
    { input: "undefined", expected: undefined },

    // Actual booleans pass through
    { input: true, expected: true },
    { input: false, expected: false },

    // Numbers
    { input: 1, expected: true },
    { input: 0, expected: false },

    // Non-values
    { input: undefined, expected: undefined },
    { input: null, expected: undefined },
  ];

  it.each(specs)(
    "parseAsBoolean($input) === $expected",
    ({ input, expected }) => {
      expect(parseAsBoolean(input)).toBe(expected);
    },
  );
});
