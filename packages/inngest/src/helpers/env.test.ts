import { afterEach, test, vi } from "vitest";
import { getProcessEnv, Mode } from "./env";

afterEach(() => {
  vi.clearAllMocks();
});

test("stingify mode", () => {
  // Mode objects must stringify to an empty object since it contains env vars

  const mode = new Mode({
    env: {
      FOO: "bar",
    },
    isExplicit: false,
    type: "cloud",
  });
  expect(JSON.stringify(mode)).toBe("{}");
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
