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
