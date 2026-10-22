import { afterEach, describe, expect, it, vi } from "vitest";
import { getRunUrl } from "./url.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getRunUrl", () => {
  it("links the Dev Server UI in dev mode", () => {
    vi.stubEnv("INNGEST_BASE_URL", "http://localhost:9999/");

    expect(getRunUrl({ runId: "R1", mode: "dev" })).toBe(
      "http://localhost:9999/run?runID=R1",
    );
  });

  it("links the dashboard environment in cloud mode", () => {
    vi.stubEnv("INNGEST_ENV", "");

    expect(getRunUrl({ runId: "R1", mode: "cloud", env: "staging" })).toBe(
      "https://app.inngest.com/env/staging/runs/R1",
    );
  });
});
