import { afterEach, vi } from "vitest";
import { getProcessEnv, parseAsBoolean, processEnv } from "./env.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("getProcessEnv", () => {
  vi.stubEnv("FOO", "bar");
  vi.stubEnv("INNGEST_SIGNING_KEY", "test");
  const env = getProcessEnv();

  // Included a whitelisted env var
  expect(env.INNGEST_SIGNING_KEY).toBe("test");

  // Did not include a non-whitelisted env var
  expect(env.FOO).toBeUndefined();
});

test("getProcessEnv result does not leak values via JSON.stringify", () => {
  vi.stubEnv("INNGEST_SIGNING_KEY", "signkey-test");
  const env = getProcessEnv();

  expect(env.INNGEST_SIGNING_KEY).toBe("signkey-test");
  expect(JSON.stringify(env)).toBe("{}");
  expect(JSON.stringify({ env })).toBe('{"env":{}}');

  // Protection carries through spreading since the `toJSON` method is
  // enumerable
  expect(JSON.stringify({ ...env })).toBe("{}");
});

test("processEnv errors on unknown key", () => {
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  expect(() => processEnv("UNKNOWN_KEY" as any)).toThrow(
    "Unknown env var: UNKNOWN_KEY",
  );
});

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
