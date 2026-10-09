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
async function getWsUrl(
  env: Record<string, string | undefined>,
): Promise<string> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const name of [
    "VITE_MODE",
    ...KEYS.flatMap((key) => PREFIXES.map((prefix) => prefix + key)),
  ]) {
    vi.stubEnv(name, undefined as unknown as string);
    delete process.env[name];
  }
  for (const key of KEYS) {
    if (env[key] !== undefined) {
      vi.stubEnv(key, env[key] as string);
    }
  }

  const { TokenSubscription } = await import("./TokenSubscription");
  const sub = new TokenSubscription(
    { channel: "chan", topics: ["t"] } as never,
    undefined,
    undefined,
    undefined,
  );

  const url = await (
    sub as unknown as { getWsUrl(token: string): Promise<URL> }
  ).getWsUrl("tok");
  return url.toString();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("TokenSubscription WS URL fallback", () => {
  test("defaults to production when NODE_ENV is unset", async () => {
    const url = await getWsUrl({});
    expect(url).toMatch(/^wss:\/\/api\.inngest\.com\//);
  });

  test("uses production when NODE_ENV is production", async () => {
    const url = await getWsUrl({ NODE_ENV: "production" });
    expect(url).toMatch(/^wss:\/\/api\.inngest\.com\//);
  });

  test("uses production for unknown NODE_ENV values", async () => {
    const url = await getWsUrl({ NODE_ENV: "test" });
    expect(url).toMatch(/^wss:\/\/api\.inngest\.com\//);
  });

  test("uses the dev server when NODE_ENV is development", async () => {
    const url = await getWsUrl({ NODE_ENV: "development" });
    expect(url).toMatch(/^ws:\/\/localhost:8288\//);
  });

  test("INNGEST_DEV=1 still selects the dev server", async () => {
    const url = await getWsUrl({ INNGEST_DEV: "1" });
    expect(url).toMatch(/^ws:\/\/localhost:8288\//);
  });

  test("INNGEST_DEV URL still takes precedence", async () => {
    const url = await getWsUrl({ INNGEST_DEV: "http://localhost:8289" });
    expect(url).toMatch(/^ws:\/\/localhost:8289\//);
  });
});
