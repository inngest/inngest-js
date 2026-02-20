import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createFetchMock from "vitest-fetch-mock";
import { ConsoleLogger } from "../middleware/logger.ts";
import {
  fetchWithAuthFallback,
  signDataWithKey,
  signWithHashJs,
} from "./net.ts";

const fetchMock = createFetchMock(vi);
const logger = new ConsoleLogger("silent");

describe("fetchWithAuthFallback", () => {
  beforeEach(() => {
    fetchMock.resetMocks();
  });

  it("should make a fetch request with the provided auth token", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ data: "12345" }));

    const response = await fetchWithAuthFallback({
      authToken: "testToken",
      fetch: fetchMock as typeof fetch,
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://example.com", {
      headers: {
        Authorization: "Bearer testToken",
      },
    });
    expect(response.status).toEqual(200);
  });

  it("should retry with the fallback token if the first request fails with 401", async () => {
    fetchMock.mockResponses(
      [JSON.stringify({}), { status: 401 }],
      [JSON.stringify({ data: "12345" }), { status: 200 }],
    );

    const response = await fetchWithAuthFallback({
      authToken: "testToken",
      authTokenFallback: "fallbackToken",
      fetch: fetchMock as typeof fetch,
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://example.com", {
      headers: {
        Authorization: "Bearer testToken",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com", {
      headers: {
        Authorization: "Bearer fallbackToken",
      },
    });
    expect(response.status).toEqual(200);
  });

  it("should retry with the fallback token if the first request fails with 403", async () => {
    fetchMock.mockResponses(
      [JSON.stringify({}), { status: 403 }],
      [JSON.stringify({ data: "12345" }), { status: 200 }],
    );

    const response = await fetchWithAuthFallback({
      authToken: "testToken",
      authTokenFallback: "fallbackToken",
      fetch: fetchMock as typeof fetch,
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://example.com", {
      headers: {
        Authorization: "Bearer testToken",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com", {
      headers: {
        Authorization: "Bearer fallbackToken",
      },
    });
    expect(response.status).toEqual(200);
  });

  it("should not retry with the fallback token if the first request fails with a non-401/403 status", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({}), { status: 500 });

    const response = await fetchWithAuthFallback({
      authToken: "testToken",
      authTokenFallback: "fallbackToken",
      fetch: fetchMock as typeof fetch,
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toEqual(500);
  });
});

describe("signing functions", () => {
  describe("signWithHashJs", () => {
    it("should produce consistent signatures", () => {
      const sig1 = signWithHashJs("data", "signkey-test-abc", "123");
      const sig2 = signWithHashJs("data", "signkey-test-abc", "123");
      expect(sig1).toBe(sig2);
    });

    it("should handle simple ASCII string data", () => {
      const result = signWithHashJs(
        "hello world",
        "signkey-test-abc123",
        "1234567890",
      );
      expect(result).toHaveLength(64); // SHA256 hex output is 64 characters
    });

    it("should handle object data (gets canonicalized)", () => {
      const obj = { b: 2, a: 1 };
      const result = signWithHashJs(obj, "signkey-test-abc123", "1234567890");
      expect(result).toHaveLength(64);

      // Verify that different object key order produces the same signature
      const obj2 = { a: 1, b: 2 };
      const result2 = signWithHashJs(obj2, "signkey-test-abc123", "1234567890");
      expect(result).toBe(result2);
    });

    it("should handle UTF-8 data with multi-byte characters", () => {
      const utf8Data = "Hello \u4e16\u754c \ud83c\udf0d"; // "Hello 世界 🌍"
      const result = signWithHashJs(
        utf8Data,
        "signkey-test-abc123",
        "1234567890",
      );
      expect(result).toHaveLength(64);
    });

    it("should handle empty string", () => {
      const result = signWithHashJs("", "signkey-test-abc123", "1234567890");
      expect(result).toHaveLength(64);
    });

    it("should strip signkey prefix before hashing", () => {
      // Key with signkey-test- prefix
      const result1 = signWithHashJs("data", "signkey-test-mykey", "123");
      // Key with signkey-prod- prefix
      const result2 = signWithHashJs("data", "signkey-prod-mykey", "123");
      // Both should strip the prefix and use "mykey" as the key
      expect(result1).toBe(result2);
    });

    it("should produce different signatures for different timestamps", () => {
      const sig1 = signWithHashJs("data", "signkey-test-abc", "123");
      const sig2 = signWithHashJs("data", "signkey-test-abc", "456");
      expect(sig1).not.toBe(sig2);
    });

    it("should produce different signatures for different data", () => {
      const sig1 = signWithHashJs("data1", "signkey-test-abc", "123");
      const sig2 = signWithHashJs("data2", "signkey-test-abc", "123");
      expect(sig1).not.toBe(sig2);
    });

    it("should produce different signatures for different keys", () => {
      const sig1 = signWithHashJs("data", "signkey-test-key1", "123");
      const sig2 = signWithHashJs("data", "signkey-test-key2", "123");
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("signDataWithKey", () => {
    describe("implementation parity", () => {
      it("should produce same output as signWithHashJs for simple ASCII string", async () => {
        const data = "hello world";
        const key = "signkey-test-abc123";
        const ts = "1234567890";

        const hashJsResult = signWithHashJs(data, key, ts);
        const nativeResult = await signDataWithKey(data, key, ts, logger);

        expect(nativeResult).toBe(hashJsResult);
      });

      it("should produce same output as signWithHashJs for object data", async () => {
        const data = { b: 2, a: 1, nested: { z: "last", a: "first" } };
        const key = "signkey-test-abc123";
        const ts = "1234567890";

        const hashJsResult = signWithHashJs(data, key, ts);
        const nativeResult = await signDataWithKey(data, key, ts, logger);

        expect(nativeResult).toBe(hashJsResult);
      });
    });

    describe("fallback behavior", () => {
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it("should fall back to signWithHashJs when crypto.subtle is unavailable", async () => {
        // Mock crypto as undefined using vi.stubGlobal
        vi.stubGlobal("crypto", undefined);

        const data = "test fallback";
        const key = "signkey-test-fallback";
        const ts = "5555555555";

        const result = await signDataWithKey(data, key, ts, logger);
        const expectedResult = signWithHashJs(data, key, ts);

        expect(result).toBe(expectedResult);
      });

      it("should fall back to signWithHashJs when native crypto throws", async () => {
        vi.stubGlobal("crypto", {
          subtle: {
            importKey: vi
              .fn()
              .mockRejectedValue(new Error("Mock crypto failure")),
          },
        });

        const data = "test error fallback";
        const key = "signkey-test-error";
        const ts = "1234567890";

        const result = await signDataWithKey(data, key, ts, logger);
        const expectedResult = signWithHashJs(data, key, ts);

        expect(result).toBe(expectedResult);
      });
    });

    describe("caching behavior", () => {
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it("should cache CryptoKey and not call importKey repeatedly for same key", async () => {
        const importKeySpy = vi.fn();
        const signSpy = vi.fn();

        const originalSubtle = globalThis.crypto.subtle;

        // Set up spies that delegate to real implementation
        importKeySpy.mockImplementation(
          (...args: Parameters<SubtleCrypto["importKey"]>) =>
            originalSubtle.importKey(...args),
        );
        signSpy.mockImplementation(
          (...args: Parameters<SubtleCrypto["sign"]>) =>
            originalSubtle.sign(...args),
        );

        vi.stubGlobal("crypto", {
          subtle: {
            importKey: importKeySpy,
            sign: signSpy,
          },
        });

        const key = "signkey-test-cached";

        // Call signDataWithKey multiple times with the same key
        await signDataWithKey("data1", key, "111", logger);
        await signDataWithKey("data2", key, "222", logger);
        await signDataWithKey("data3", key, "333", logger);

        // importKey should only be called once due to caching
        expect(importKeySpy).toHaveBeenCalledTimes(1);
        // sign should be called 3 times
        expect(signSpy).toHaveBeenCalledTimes(3);
      });
    });
  });
});
