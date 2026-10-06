/**
 * Tests for reading why a run failed from the Dev Server's REST API, with
 * responses shaped like the real ones.
 *
 * @module
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { failureReason, runFailureReason } from "./devServerApi.ts";

const message = "Sandbox did not reach RUNNING within 120000 milliseconds";

/** `GET /v2/runs/{id}?includeOutput=true` for a run a step's error ended. */
const singleRun = {
  data: {
    id: "01M48CQF5D38XEF4S3PAGEVJ43",
    status: "FAILED",
    output: {
      __serialized: true,
      message,
      name: "NonRetriableError",
      stack: `NonRetriableError: ${message}\n    at file:///app.mjs:6:50`,
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("failureReason", () => {
  test("reads the error a single run answers with", () => {
    expect(failureReason(singleRun.data.output)).toBe(
      "machine didn't start in 2m",
    );
  });

  test("reads the error the run list wraps", () => {
    expect(failureReason({ error: singleRun.data.output })).toBe(
      "machine didn't start in 2m",
    );
  });

  test("takes the first meaningful line", () => {
    expect(failureReason({ message: "\n  first\nsecond" })).toBe("first");
    expect(failureReason("plain\nstring")).toBe("plain");
  });

  test("has nothing to say about an output that isn't an error", () => {
    expect(failureReason(undefined)).toBeUndefined();
    expect(failureReason({ ok: true })).toBeUndefined();
  });
});

describe("runFailureReason", () => {
  test("asks for the output and returns the error's message", async () => {
    const fetchMock = vi.fn(async (_url: string) => {
      return new Response(JSON.stringify(singleRun));
    });

    vi.stubGlobal("fetch", fetchMock);

    expect(
      await runFailureReason("http://127.0.0.1:1", singleRun.data.id),
    ).toBe("machine didn't start in 2m");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:1/v2/runs/${singleRun.data.id}?includeOutput=true`,
    );
  });

  test("gives up quietly when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );

    expect(await runFailureReason("http://127.0.0.1:1", "r")).toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("no", { status: 404 });
      }),
    );

    expect(await runFailureReason("http://127.0.0.1:1", "r")).toBeUndefined();
  });
});
