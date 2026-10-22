import { afterEach, describe, expect, it, vi } from "vitest";
import { getRunUrl } from "./url.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getRunUrl", () => {
  it("links the Dev Server UI in dev mode", () => {
    expect(
      getRunUrl({
        runId: "R1",
        mode: "dev",
        baseUrl: "http://localhost:9999/",
      }),
    ).toBe("http://localhost:9999/run?runID=R1");
  });

  it("links the dashboard environment in cloud mode", () => {
    vi.stubEnv("INNGEST_ENV", "");

    expect(
      getRunUrl({
        runId: "R1",
        mode: "cloud",
        baseUrl: "https://api.inngest.com",
        env: "staging",
      }),
    ).toBe("https://app.inngest.com/env/staging/runs/R1");
  });
});
