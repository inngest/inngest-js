/**
 * Tests for reading why a run failed from the Dev Server's REST API, with
 * responses shaped like the real ones.
 *
 * @module
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  failureReason,
  runFailureReason,
  sandboxAccessProblemOf,
} from "./devServerApi.ts";

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

describe("sandboxAccessProblemOf", () => {
  const reply = (status: number, code?: string): Response => {
    return new Response(
      JSON.stringify(
        code
          ? { errors: [{ code, message: "x" }] }
          : { data: { sandboxIds: [] } },
      ),
      { status },
    );
  };

  /** Answers each path from a table, and records the paths asked. */
  const stub = (answers: Record<string, Response | Error>) => {
    const asked: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace("http://dev", "");
        const answer = answers[path] ?? reply(200);

        asked.push(path);

        if (answer instanceof Error) {
          throw answer;
        }

        return answer;
      }),
    );

    return asked;
  };

  const status = "/dev/cloud/status";
  const list = "/v2/sandboxes?limit=1";

  test("is no problem when logged in and Sandboxes list", async () => {
    const asked = stub({});

    expect(await sandboxAccessProblemOf("http://dev")).toBeUndefined();
    expect(asked).toEqual([status, list]);
  });

  test("is a login problem when the Dev Server isn't logged in", async () => {
    const asked = stub({ [status]: reply(401, "cloud_login_required") });

    expect(await sandboxAccessProblemOf("http://dev")).toBe("login");
    expect(asked).toEqual([status]);
  });

  test("is an environment problem when the login has no single environment", async () => {
    stub({ [status]: reply(400, "environment_required") });

    expect(await sandboxAccessProblemOf("http://dev")).toBe("environment");
  });

  test("is a plan problem when Cloud refuses the list", async () => {
    stub({ [list]: reply(403, "access_denied") });

    expect(await sandboxAccessProblemOf("http://dev")).toBe("plan");
  });

  test("lets unknown errors through", async () => {
    stub({
      [status]: reply(404),
      [list]: reply(503, "compute_unavailable"),
    });

    expect(await sandboxAccessProblemOf("http://dev")).toBeUndefined();
  });

  test("lets an unreachable Dev Server through", async () => {
    stub({ [status]: new Error("connect ECONNREFUSED") });

    expect(await sandboxAccessProblemOf("http://dev")).toBeUndefined();
  });
});
