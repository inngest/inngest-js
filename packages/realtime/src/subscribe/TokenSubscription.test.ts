import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The WS URL fallback reads environment variables captured at module load,
 * so each case re-imports the module with a fresh environment.
 */
async function getWsUrl(
  env: Record<string, string | undefined>,
): Promise<string> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const key of ["NODE_ENV", "INNGEST_DEV"]) {
    const value = env[key];
    if (value === undefined) {
      vi.stubEnv(key, undefined as unknown as string);
      delete process.env[key];
    } else {
      vi.stubEnv(key, value);
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
