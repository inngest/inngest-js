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

describe("InngestApi.cancelRun", () => {
  const apiWith = (respond: () => Response) => {
    const calls: { url: string; method?: string }[] = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: input.toString(), method: init?.method });

      return respond();
    });
    const api = new InngestApi({
      baseUrl: () => {
        return "https://api.example.test";
      },
      signingKey: () => {
        return "signkey-test";
      },
      signingKeyFallback: () => {
        return undefined;
      },
      environment: () => {
        return null;
      },
      fetch: () => {
        return fetchMock;
      },
    });

    return { api, calls };
  };

  test("deletes the run", async () => {
    const { api, calls } = apiWith(() => {
      return new Response(null, { status: 204 });
    });

    expect((await api.cancelRun("01ABC/x")).ok).toBe(true);
    expect(calls).toEqual([
      { url: "https://api.example.test/v1/runs/01ABC%2Fx", method: "DELETE" },
    ]);
  });

  test("a run that is gone is a 404 error, so the caller decides; a request with no answer has status 0", async () => {
    const gone = await apiWith(() => {
      return new Response(null, { status: 404 });
    }).api.cancelRun("r");
    const failed = await apiWith(() => {
      return new Response("nope", { status: 500 });
    }).api.cancelRun("r");
    const noAnswer = await new InngestApi({
      baseUrl: () => {
        return "https://api.example.test";
      },
      signingKey: () => {
        return "signkey-test";
      },
      signingKeyFallback: () => {
        return undefined;
      },
      environment: () => {
        return null;
      },
      fetch: () => {
        return (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch;
      },
    }).cancelRun("r");

    expect(!gone.ok && gone.error?.status).toBe(404);
    expect(!failed.ok && failed.error?.status).toBe(500);
    expect(!noAnswer.ok && noAnswer.error?.status).toBe(0);
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
