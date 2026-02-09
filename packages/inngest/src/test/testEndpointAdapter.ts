import { describe, expect, test, vi } from "vitest";
import { Inngest } from "../components/Inngest.ts";
import { InngestEndpointAdapter } from "../components/InngestEndpointAdapter.ts";
import { createClient } from "./helpers.ts";

export interface NormalizedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface TestEndpointAdapterOptions {
  invokeProxy: (
    client: Inngest.Any,
    request: { url: string; method: string },
  ) => Promise<NormalizedResponse>;

  lifecycleChanges?: () => void;
}

export function testEndpointAdapter(
  name: string,
  endpointAdapter: InngestEndpointAdapter.Like & {
    createProxyHandler: InngestEndpointAdapter.ProxyFn;
  },
  options: TestEndpointAdapterOptions,
): void {
  const { invokeProxy, lifecycleChanges } = options;

  const createProxyClient = () =>
    createClient({ id: "test", endpointAdapter });

  const mockSuccessAPI = (data: unknown = { data: "result" }) =>
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(data), { status: 200 }),
    );

  describe(`${name} endpointAdapter`, () => {
    lifecycleChanges?.();

    describe("adapter interface", () => {
      test("has createProxyHandler", () => {
        expect(typeof endpointAdapter.createProxyHandler).toBe("function");
      });

      test("withOptions preserves createProxyHandler", () => {
        const configured = endpointAdapter.withOptions({
          asyncRedirectUrl: "/poll",
        });

        expect(typeof configured.createProxyHandler).toBe("function");
      });
    });

    describe("client.endpoint()", () => {
      test("throws when client has no endpointAdapter", () => {
        const inngest = new Inngest({ id: "no-adapter" });
        // biome-ignore lint/suspicious/noExplicitAny: test
        const noop = (async () => {}) as any;

        expect(() => inngest.endpoint(noop)).toThrow(
          "No endpoint adapter configured",
        );
      });

      test("returns a callable handler", () => {
        const inngest = new Inngest({ id: "test-app", endpointAdapter });
        // biome-ignore lint/suspicious/noExplicitAny: test
        const noop = (async () => {}) as any;

        expect(typeof inngest.endpoint(noop)).toBe("function");
      });
    });

    describe("client.endpointProxy()", () => {
      test("throws when client has no endpointAdapter", () => {
        const inngest = new Inngest({ id: "no-adapter" });

        expect(() => inngest.endpointProxy()).toThrow(
          "No endpoint adapter configured",
        );
      });

      test("throws when adapter lacks createProxyHandler", () => {
        const adapterWithoutProxy = InngestEndpointAdapter.create(vi.fn());
        const inngest = new Inngest({
          id: "test-app",
          endpointAdapter: adapterWithoutProxy,
        });

        expect(() => inngest.endpointProxy()).toThrow(
          "does not support proxy handlers",
        );
      });

      test("returns a callable handler", () => {
        expect(typeof createProxyClient().endpointProxy()).toBe("function");
      });
    });

    describe("proxy handler", () => {
      test("OPTIONS returns 204 with CORS headers", async () => {
        const res = await invokeProxy(createProxyClient(), {
          url: "https://example.com/api/poll",
          method: "OPTIONS",
        });

        expect(res.status).toBe(204);
        expect(res.body).toBe("");
        const origin =
          res.headers["access-control-allow-origin"] ??
          res.headers["Access-Control-Allow-Origin"];
        const methods =
          res.headers["access-control-allow-methods"] ??
          res.headers["Access-Control-Allow-Methods"];
        const maxAge =
          res.headers["access-control-max-age"] ??
          res.headers["Access-Control-Max-Age"];
        expect(origin).toBe("*");
        expect(methods).toBe("GET, OPTIONS");
        expect(maxAge).toBe("86400");
      });

      test("GET extracts runId and token from query params", async () => {
        const mockGetRunOutput = mockSuccessAPI();
        const client = createProxyClient();
        client["inngestApi"]["getRunOutput"] = mockGetRunOutput;

        await invokeProxy(client, {
          url: "https://example.com/api/poll?runId=run-123&token=tok-abc",
          method: "GET",
        });

        expect(mockGetRunOutput).toHaveBeenCalledWith("run-123", "tok-abc");
      });

      test("GET with missing params returns 400", async () => {
        const res = await invokeProxy(createProxyClient(), {
          url: "https://example.com/api/poll",
          method: "GET",
        });

        expect(res.status).toBe(400);
        expect(JSON.parse(res.body)).toEqual({
          error: "Missing runId or token query parameter",
        });
      });

      test("GET with only runId returns 400", async () => {
        const res = await invokeProxy(createProxyClient(), {
          url: "https://example.com/api/poll?runId=run-123",
          method: "GET",
        });

        expect(res.status).toBe(400);
      });

      test("GET with only token returns 400", async () => {
        const res = await invokeProxy(createProxyClient(), {
          url: "https://example.com/api/poll?token=tok-abc",
          method: "GET",
        });

        expect(res.status).toBe(400);
      });

      test("success response includes parsed JSON body", async () => {
        const client = createProxyClient();
        client["inngestApi"]["getRunOutput"] = mockSuccessAPI({
          users: [{ id: 1 }],
        });

        const res = await invokeProxy(client, {
          url: "https://example.com/api/poll?runId=r&token=t",
          method: "GET",
        });

        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ users: [{ id: 1 }] });
      });

      test("success response includes Content-Type and CORS headers", async () => {
        const client = createProxyClient();
        client["inngestApi"]["getRunOutput"] = mockSuccessAPI();

        const res = await invokeProxy(client, {
          url: "https://example.com/api/poll?runId=r&token=t",
          method: "GET",
        });

        const ct =
          res.headers["content-type"] ?? res.headers["Content-Type"];
        const origin =
          res.headers["access-control-allow-origin"] ??
          res.headers["Access-Control-Allow-Origin"];
        expect(ct).toBe("application/json");
        expect(origin).toBe("*");
      });

      test("non-ok API response forwards status", async () => {
        const client = createProxyClient();
        client["inngestApi"]["getRunOutput"] = vi
          .fn()
          .mockResolvedValue(new Response("Not Found", { status: 404 }));

        const res = await invokeProxy(client, {
          url: "https://example.com/api/poll?runId=r&token=t",
          method: "GET",
        });

        expect(res.status).toBe(404);
        expect(res.body).toContain("Not Found");
      });

      test("API exception returns 500 with error message", async () => {
        const client = createProxyClient();
        client["inngestApi"]["getRunOutput"] = vi
          .fn()
          .mockRejectedValue(new Error("Connection refused"));

        const res = await invokeProxy(client, {
          url: "https://example.com/api/poll?runId=r&token=t",
          method: "GET",
        });

        expect(res.status).toBe(500);
        expect(JSON.parse(res.body).error).toBe("Connection refused");
      });

      test("non-Error exception returns 500 with generic message", async () => {
        const client = createProxyClient();
        client["inngestApi"]["getRunOutput"] = vi
          .fn()
          .mockRejectedValue("string-error");

        const res = await invokeProxy(client, {
          url: "https://example.com/api/poll?runId=r&token=t",
          method: "GET",
        });

        expect(res.status).toBe(500);
        expect(JSON.parse(res.body).error).toBe(
          "Failed to fetch run output",
        );
      });

      test("response body uses decryptProxyResult output", async () => {
        const client = createProxyClient();
        client["inngestApi"]["getRunOutput"] = mockSuccessAPI({
          data: "raw-from-api",
        });
        client["decryptProxyResult"] = vi
          .fn()
          .mockResolvedValue({ data: "after-decrypt" });

        const res = await invokeProxy(client, {
          url: "https://example.com/api/poll?runId=r&token=t",
          method: "GET",
        });

        expect(JSON.parse(res.body)).toEqual({ data: "after-decrypt" });
      });

      test("decryptProxyResult exception returns 500", async () => {
        const client = createProxyClient();
        client["inngestApi"]["getRunOutput"] = mockSuccessAPI();
        client["decryptProxyResult"] = vi
          .fn()
          .mockRejectedValue(new Error("Decryption failed"));

        const res = await invokeProxy(client, {
          url: "https://example.com/api/poll?runId=r&token=t",
          method: "GET",
        });

        expect(res.status).toBe(500);
        expect(JSON.parse(res.body).error).toBe("Decryption failed");
      });
    });
  });
}
