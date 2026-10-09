import { afterEach, describe, expect, test, vi } from "vitest";

const PREFIXES = [
  "",
  "NEXT_PUBLIC_",
  "REACT_APP_",
  "NUXT_PUBLIC_",
  "VUE_APP_",
  "VITE_",
];
const KEYS = [
  "NODE_ENV",
  "INNGEST_DEV",
  "INNGEST_BASE_URL",
  "INNGEST_API_BASE_URL",
];

// env is read at module load, so re-import with a clean environment each time.
async function getTokenUrl(
  env: Record<string, string | undefined>,
  apiBaseUrl?: string,
): Promise<string> {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_MODE", undefined as unknown as string);
  delete process.env.VITE_MODE;
  for (const key of KEYS) {
    for (const prefix of PREFIXES) {
      vi.stubEnv(prefix + key, undefined as unknown as string);
      delete process.env[prefix + key];
    }
    if (env[key] !== undefined) {
      vi.stubEnv(key, env[key] as string);
    }
  }

  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ jwt: "jwt" }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const { api } = await import("./api");
  await api.getSubscriptionToken({
    channel: "chan",
    topics: ["t"],
    signingKey: undefined,
    signingKeyFallback: undefined,
    apiBaseUrl,
  });

  return String(fetchMock.mock.calls[0]?.[0]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("api.getSubscriptionToken URL fallback", () => {
  test("defaults to production when NODE_ENV is unset", async () => {
    expect(await getTokenUrl({})).toBe(
      "https://api.inngest.com/v1/realtime/token",
    );
  });

  test("uses production when NODE_ENV is production", async () => {
    expect(await getTokenUrl({ NODE_ENV: "production" })).toBe(
      "https://api.inngest.com/v1/realtime/token",
    );
  });

  test("uses the dev server when NODE_ENV is development", async () => {
    expect(await getTokenUrl({ NODE_ENV: "development" })).toBe(
      "http://localhost:8288/v1/realtime/token",
    );
  });

  test("INNGEST_DEV=1 selects the dev server", async () => {
    expect(await getTokenUrl({ INNGEST_DEV: "1" })).toBe(
      "http://localhost:8288/v1/realtime/token",
    );
  });

  test("INNGEST_DEV URL takes precedence", async () => {
    expect(await getTokenUrl({ INNGEST_DEV: "http://localhost:8289" })).toBe(
      "http://localhost:8289/v1/realtime/token",
    );
  });

  test("an explicit base URL takes precedence", async () => {
    expect(
      await getTokenUrl({ NODE_ENV: "development" }, "https://example.test"),
    ).toBe("https://example.test/v1/realtime/token");
  });
});
