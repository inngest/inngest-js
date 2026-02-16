import fetch, { Headers, Response } from "cross-fetch";
import * as EdgeHandler from "./edge.ts";
import { endpointAdapter } from "./edge.ts";
import { Inngest } from "./index.ts";
import { createClient, testFramework } from "./test/helpers.ts";

const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

// Shared setup/teardown for edge environment globals
const setupEdgeGlobals = () => {
  vi.resetModules();
  Object.defineProperties(globalThis, {
    fetch: { value: fetch, configurable: true },
    Response: { value: Response, configurable: true },
    Headers: { value: Headers, configurable: true },
  });
};

const teardownEdgeGlobals = () => {
  Object.defineProperties(globalThis, {
    fetch: { value: originalFetch, configurable: true },
    Response: { value: originalResponse, configurable: true },
    Headers: { value: originalHeaders, configurable: true },
  });
};

testFramework("Edge", EdgeHandler, {
  lifecycleChanges: () => {
    beforeEach(setupEdgeGlobals);
    afterEach(teardownEdgeGlobals);
  },
  transformReq: (req) => {
    const headers = new Headers();
    // biome-ignore lint/complexity/noForEach: intentional
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    (req as any).headers = headers;

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    (req as any).text = () =>
      Promise.resolve(req.body === undefined ? "" : JSON.stringify(req.body));

    return [req];
  },
  transformRes: async (_args, ret: Response) => {
    const headers: Record<string, string> = {};

    ret.headers.forEach((v, k) => {
      headers[k] = v;
    });

    return {
      status: ret.status,
      body: await ret.text(),
      headers,
    };
  },
});

describe("Edge endpointAdapter", () => {
  beforeEach(setupEdgeGlobals);
  afterEach(teardownEdgeGlobals);

  // Helper to create client with endpointAdapter
  const createProxyClient = () => createClient({ id: "test", endpointAdapter });

  describe("endpointAdapter interface", () => {
    test("has createProxyHandler and withOptions", () => {
      expect(typeof endpointAdapter.createProxyHandler).toBe("function");
      expect(typeof endpointAdapter.withOptions).toBe("function");
    });

    test("withOptions returns adapter with same interface", () => {
      const configured = endpointAdapter.withOptions({
        asyncRedirectUrl: "/api/poll",
      });

      expect(configured.withOptions).toBeDefined();
      expect(configured.createProxyHandler).toBeDefined();
    });
  });

  describe("proxy handler", () => {
    test("creates a callable proxy handler", () => {
      expect(typeof createProxyClient().endpointProxy()).toBe("function");
    });

    test("handles CORS preflight", async () => {
      const res = await createProxyClient().endpointProxy()(
        new Request("https://example.com/api/poll", { method: "OPTIONS" }),
      );

      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, OPTIONS",
      );
    });

    test("returns 400 for missing parameters", async () => {
      const res = await createProxyClient().endpointProxy()(
        new Request("https://example.com/api/poll", { method: "GET" }),
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        "Missing runId or token query parameter",
      );
    });

    test("extracts runId and token from query params", async () => {
      const mockGetRunOutput = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: "test-result" }), {
          status: 200,
        }),
      );

      const inngest = createProxyClient();
      inngest["inngestApi"]["getRunOutput"] = mockGetRunOutput;

      const res = await inngest.endpointProxy()(
        new Request(
          "https://example.com/api/poll?runId=run-123&token=token-abc",
          { method: "GET" },
        ),
      );

      expect(mockGetRunOutput).toHaveBeenCalledWith("run-123", "token-abc");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: "test-result" });
    });
  });

  describe("integration with Inngest client", () => {
    test("client can create endpoint and proxy handlers", () => {
      const inngest = new Inngest({ id: "test-app", endpointAdapter });

      expect(typeof inngest.endpoint(async () => new Response("OK"))).toBe(
        "function",
      );
      expect(typeof inngest.endpointProxy()).toBe("function");
    });

    test("asyncRedirectUrl can be configured via withOptions", () => {
      const inngest = new Inngest({
        id: "test-app",
        endpointAdapter: endpointAdapter.withOptions({
          asyncRedirectUrl: "/custom/poll/path",
        }),
      });

      expect(typeof inngest.endpointProxy()).toBe("function");
    });
  });
});
