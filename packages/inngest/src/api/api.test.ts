import { Inngest } from "../components/Inngest.ts";
import { envKeys } from "../helpers/consts.ts";
import { version } from "../version.ts";
import { InngestApi } from "./api.ts";

describe("InngestApi environment headers", () => {
  test("adds the environment without changing request content types", async () => {
    const headers: Headers[] = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      headers.push(new Headers(init?.headers));
      const url = input.toString();
      if (url.endsWith("/v1/realtime/token")) {
        return Response.json({ jwt: "token" });
      }
      return new Response(null, { status: 200 });
    });
    const api = new InngestApi({
      baseUrl: () => "https://api.example.test",
      signingKey: () => "signkey-test",
      signingKeyFallback: () => undefined,
      environment: () => "preview",
      fetch: () => fetchMock,
    });

    await api.checkpointStepsAsync({
      runId: "run-id",
      fnId: "fn-id",
      queueItemId: "queue-item-id",
      generationId: undefined,
      requestId: undefined,
      requestStartedAt: undefined,
      steps: [],
    });
    await api.getSubscriptionToken("channel", ["topic"]);
    await api.checkpointStream({
      runId: "run-id",
      body: new ReadableStream(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const requestHeaders of headers) {
      expect(requestHeaders.get("X-Inngest-Env")).toBe("preview");
      expect(requestHeaders.get("X-Inngest-Sdk")).toBe(
        `inngest-js:v${version}`,
      );
    }
    expect(headers.map((value) => value.get("Content-Type"))).toEqual([
      "application/json",
      "application/json",
      "application/octet-stream",
    ]);
  });
});

describe("InngestApi instance ID header", () => {
  const createApi = (instanceId?: string) => {
    const headers: Headers[] = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      headers.push(new Headers(init?.headers));
      if (input.toString().endsWith("/v1/checkpoint")) {
        return Response.json({
          data: {
            fn_id: "fn-id",
            app_id: "app-id",
            run_id: "run-id",
            realtime_token: "realtime-token",
          },
        });
      }
      return new Response(null, { status: 200 });
    });
    const api = new InngestApi({
      baseUrl: () => "https://api.example.test",
      signingKey: () => "signkey-test",
      signingKeyFallback: () => undefined,
      environment: () => null,
      fetch: () => fetchMock,
      instanceId: () => instanceId,
    });

    return { api, headers };
  };

  const callCheckpoints = async (api: InngestApi) => {
    await api.checkpointNewRun({
      runId: "run-id",
      event: {
        name: "inngest/http.request",
        data: {
          domain: "example.test",
          method: "GET",
          path: "/",
          ip: "127.0.0.1",
          content_type: "application/json",
          query_params: "",
        },
      },
      executionVersion: 2,
      retries: 0,
    });
    await api.checkpointSteps({
      runId: "run-id",
      fnId: "fn-id",
      appId: "app-id",
      steps: [],
    });
    await api.checkpointStepsAsync({
      runId: "run-id",
      fnId: "fn-id",
      queueItemId: "queue-item-id",
      generationId: undefined,
      requestId: undefined,
      requestStartedAt: undefined,
      steps: [],
    });
  };

  test("sends the instance ID on every checkpoint request", async () => {
    const { api, headers } = createApi("instance-1");
    await callCheckpoints(api);

    expect(headers).toHaveLength(3);
    for (const requestHeaders of headers) {
      expect(requestHeaders.get("x-inngest-instance-id")).toBe("instance-1");
    }
  });

  test("omits the header when no instance ID is set", async () => {
    const { api, headers } = createApi(undefined);
    await callCheckpoints(api);

    expect(headers).toHaveLength(3);
    for (const requestHeaders of headers) {
      expect(requestHeaders.has("x-inngest-instance-id")).toBe(false);
    }
  });

  test("the client reads INNGEST_CONNECT_INSTANCE_ID from the environment", async () => {
    vi.stubEnv(envKeys.InngestConnectInstanceId, "instance-from-env");
    try {
      const headers: Headers[] = [];
      const fetchMock: typeof fetch = vi.fn(async (_input, init) => {
        headers.push(new Headers(init?.headers));
        return new Response(null, { status: 200 });
      });
      const client = new Inngest({
        id: "test-app",
        isDev: true,
        fetch: fetchMock,
      });

      await client["inngestApi"].checkpointSteps({
        runId: "run-id",
        fnId: "fn-id",
        appId: "app-id",
        steps: [],
      });

      expect(headers).toHaveLength(1);
      expect(headers[0]?.get("x-inngest-instance-id")).toBe(
        "instance-from-env",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("InngestApi run data errors", () => {
  const createApi = (response: () => Response) =>
    new InngestApi({
      baseUrl: () => "https://api.example.test",
      signingKey: () => "signkey-test",
      signingKeyFallback: () => undefined,
      environment: () => null,
      fetch: () => vi.fn(async () => response()),
    });

  const methods = [
    ["getRunSteps", (api: InngestApi) => api.getRunSteps("run-id")],
    ["getRunBatch", (api: InngestApi) => api.getRunBatch("run-id")],
  ] as const;

  describe.each(methods)("%s", (_name, call) => {
    test("returns an error result for a non-JSON error response", async () => {
      const api = createApi(
        () =>
          new Response("<html>Bad Gateway</html>", {
            status: 502,
            statusText: "Bad Gateway",
          }),
      );

      const result = await call(api);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error?.status).toBe(502);
        expect(result.error?.error).toContain("502");
        expect(result.error?.error).toContain("Bad Gateway");
      }
    });

    test("returns an error result for a JSON error response without a status", async () => {
      const api = createApi(() =>
        Response.json({ error: "run not found" }, { status: 404 }),
      );

      const result = await call(api);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error?.status).toBe(404);
        expect(result.error?.error).toContain("404");
        expect(result.error?.error).toContain("run not found");
      }
    });

    test("keeps the whole body for a JSON error response with unexpected fields", async () => {
      const api = createApi(() =>
        Response.json(
          { error: "upstream failed", status: "bad", request_id: "req-123" },
          { status: 500 },
        ),
      );

      const result = await call(api);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error?.status).toBe(500);
        expect(result.error?.error).toContain("upstream failed");
        expect(result.error?.error).toContain("req-123");
      }
    });

    test("truncates a large error body", async () => {
      const api = createApi(
        () => new Response("x".repeat(100_000), { status: 502 }),
      );

      const result = await call(api);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error?.error.length).toBeLessThan(2_000);
        expect(result.error?.error).toContain("(truncated)");
      }
    });

    test("reports a failure to read the error body", async () => {
      const api = createApi(
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("connection reset"));
              },
            }),
            { status: 502 },
          ),
      );

      const result = await call(api);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error?.status).toBe(502);
        expect(result.error?.error).toContain(
          "failed to read the response body: connection reset",
        );
      }
    });

    test("keeps the error result for a well-formed error response", async () => {
      const api = createApi(() =>
        Response.json({ error: "denied", status: 403 }, { status: 403 }),
      );

      const result = await call(api);

      expect(result).toEqual({
        ok: false,
        error: { error: "denied", status: 403 },
      });
    });
  });
});
