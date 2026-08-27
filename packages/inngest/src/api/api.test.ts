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
    }
    expect(headers.map((value) => value.get("Content-Type"))).toEqual([
      "application/json",
      "application/json",
      "application/octet-stream",
    ]);
  });
});
