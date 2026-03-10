import { describe, expect, test, vi } from "vitest";
import type { Inngest } from "./Inngest.ts";
import {
  type DurableEndpointProxyContext,
  handleDurableEndpointProxyRequest,
} from "./InngestDurableEndpointProxy.ts";

describe("InngestDurableEndpointProxy", () => {
  describe("handleDurableEndpointProxyRequest", () => {
    // Default mock implementations
    const defaultGetRunOutput = () =>
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: "test-result" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const defaultDecrypt = () => vi.fn().mockImplementation((r) => r);

    // Helper to create mock client with overrides
    const createMockClient = (
      overrides: {
        getRunOutput?: ReturnType<typeof vi.fn>;
        decryptProxyResult?: ReturnType<typeof vi.fn>;
      } = {},
    ) =>
      ({
        inngestApi: {
          getRunOutput: overrides.getRunOutput ?? defaultGetRunOutput(),
        },
        decryptProxyResult: overrides.decryptProxyResult ?? defaultDecrypt(),
      }) as unknown as Inngest.Any;

    // Common request contexts
    const validRequest: DurableEndpointProxyContext = {
      runId: "run-123",
      token: "token-abc",
      method: "GET",
    };

    const optionsRequest: DurableEndpointProxyContext = {
      runId: null,
      token: null,
      method: "OPTIONS",
    };

    // Helper to create request with overrides
    const request = (
      overrides: Partial<DurableEndpointProxyContext> = {},
    ): DurableEndpointProxyContext => ({
      ...validRequest,
      ...overrides,
    });

    describe("CORS preflight (OPTIONS request)", () => {
      test("returns 204 with CORS headers", async () => {
        const result = await handleDurableEndpointProxyRequest(
          createMockClient(),
          optionsRequest,
        );

        expect(result.status).toBe(204);
        expect(result.body).toBe("");
        expect(result.headers).toMatchObject({
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        });
      });
    });

    describe("parameter validation", () => {
      test.each([
        { runId: null, token: "valid-token", desc: "runId missing" },
        { runId: "valid-run-id", token: null, desc: "token missing" },
        { runId: null, token: null, desc: "both missing" },
      ])("returns 400 when $desc", async ({ runId, token }) => {
        const result = await handleDurableEndpointProxyRequest(
          createMockClient(),
          request({ runId, token }),
        );

        expect(result.status).toBe(400);
        expect(result.headers["Content-Type"]).toBe("application/json");
        expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
        expect(JSON.parse(result.body).error).toBe(
          "Missing runId or token query parameter",
        );
      });
    });

    describe("successful requests", () => {
      test("fetches run output and returns it with CORS headers", async () => {
        const mockGetRunOutput = defaultGetRunOutput();
        const mockDecrypt = defaultDecrypt();

        const result = await handleDurableEndpointProxyRequest(
          createMockClient({
            getRunOutput: mockGetRunOutput,
            decryptProxyResult: mockDecrypt,
          }),
          validRequest,
        );

        expect(mockGetRunOutput).toHaveBeenCalledWith("run-123", "token-abc");
        expect(mockDecrypt).toHaveBeenCalledWith({ data: "test-result" });
        expect(result.status).toBe(200);
        expect(result.headers["Content-Type"]).toBe("application/json");
        expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
        expect(JSON.parse(result.body)).toEqual({ data: "test-result" });
      });

      test("decrypts response via middleware", async () => {
        const mockDecrypt = vi.fn().mockImplementation((r) => ({
          ...r,
          data: "decrypted-data",
        }));

        const result = await handleDurableEndpointProxyRequest(
          createMockClient({
            getRunOutput: vi.fn().mockResolvedValue(
              new Response(JSON.stringify({ data: "encrypted-data" }), {
                status: 200,
              }),
            ),
            decryptProxyResult: mockDecrypt,
          }),
          validRequest,
        );

        expect(mockDecrypt).toHaveBeenCalledWith({ data: "encrypted-data" });
        expect(JSON.parse(result.body)).toEqual({ data: "decrypted-data" });
      });
    });

    describe("error handling", () => {
      test("forwards error response from Inngest API", async () => {
        const result = await handleDurableEndpointProxyRequest(
          createMockClient({
            getRunOutput: vi
              .fn()
              .mockResolvedValue(new Response("Not Found", { status: 404 })),
          }),
          validRequest,
        );

        expect(result.status).toBe(404);
        expect(result.body).toBe("Not Found");
        expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
      });

      test("returns 500 when API fetch throws", async () => {
        const result = await handleDurableEndpointProxyRequest(
          createMockClient({
            getRunOutput: vi.fn().mockRejectedValue(new Error("Network error")),
          }),
          validRequest,
        );

        expect(result.status).toBe(500);
        expect(result.headers["Content-Type"]).toBe("application/json");
        expect(JSON.parse(result.body).error).toBe("Network error");
      });

      test("returns generic error for non-Error exceptions", async () => {
        const result = await handleDurableEndpointProxyRequest(
          createMockClient({
            getRunOutput: vi.fn().mockRejectedValue("string error"),
          }),
          validRequest,
        );

        expect(result.status).toBe(500);
        expect(JSON.parse(result.body).error).toBe(
          "Failed to fetch run output",
        );
      });

      test("returns 500 when decryption throws", async () => {
        const result = await handleDurableEndpointProxyRequest(
          createMockClient({
            decryptProxyResult: vi
              .fn()
              .mockRejectedValue(new Error("Decryption failed")),
          }),
          validRequest,
        );

        expect(result.status).toBe(500);
        expect(JSON.parse(result.body).error).toBe("Decryption failed");
      });
    });
  });
});
