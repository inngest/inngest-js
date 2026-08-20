import { describe, expect, test, vi } from "vitest";
import type { Inngest } from "./Inngest.ts";
import { InngestEndpointAdapter } from "./InngestEndpointAdapter.ts";

describe("InngestEndpointAdapter", () => {
  describe("create", () => {
    test("creates adapter with Symbol.toStringTag", () => {
      const rawFn = vi.fn();
      const adapter = InngestEndpointAdapter.create(rawFn);

      expect(adapter[Symbol.toStringTag]).toBe(InngestEndpointAdapter.Tag);
    });

    test("created adapter is callable and invokes rawFn", () => {
      const rawFn = vi.fn().mockReturnValue("handler-result");
      const adapter = InngestEndpointAdapter.create(rawFn);

      const options = {
        client: {} as Inngest.Like,
      };

      const result = adapter(options);

      expect(rawFn).toHaveBeenCalledWith(options);
      expect(result).toBe("handler-result");
    });

    test("withOptions merges scoped options", () => {
      const rawFn = vi.fn();
      const adapter = InngestEndpointAdapter.create(rawFn);

      const withRedirect = adapter.withOptions({
        asyncRedirectUrl: "/api/poll",
      });

      withRedirect({ client: {} as Inngest.Like });

      expect(rawFn).toHaveBeenCalledWith(
        expect.objectContaining({
          asyncRedirectUrl: "/api/poll",
        }),
      );
    });

    test("withOptions can be chained", () => {
      const rawFn = vi.fn();
      const adapter = InngestEndpointAdapter.create(rawFn);

      const configured = adapter
        .withOptions({ asyncRedirectUrl: "/api/poll" })
        .withOptions({ functionId: "my-func" });

      configured({ client: {} as Inngest.Like });

      expect(rawFn).toHaveBeenCalledWith(
        expect.objectContaining({
          asyncRedirectUrl: "/api/poll",
          functionId: "my-func",
        }),
      );
    });

    test("call-site options override scoped options", () => {
      const rawFn = vi.fn();
      const adapter = InngestEndpointAdapter.create(rawFn);

      const withOptions = adapter.withOptions({
        asyncRedirectUrl: "/scoped-path",
      });

      withOptions({
        client: {} as Inngest.Like,
        asyncRedirectUrl: "/call-site-path",
      });

      expect(rawFn).toHaveBeenCalledWith(
        expect.objectContaining({
          asyncRedirectUrl: "/call-site-path",
        }),
      );
    });
  });

  describe("createProxyHandler", () => {
    test("adapter without proxy handler has undefined createProxyHandler", () => {
      const rawFn = vi.fn();
      const adapter = InngestEndpointAdapter.create(rawFn);

      expect(adapter.createProxyHandler).toBeUndefined();
    });

    test("adapter with proxy handler has createProxyHandler defined", () => {
      const rawFn = vi.fn();
      const proxyFn = vi.fn().mockReturnValue("proxy-handler");
      const adapter = InngestEndpointAdapter.create(rawFn, proxyFn);

      expect(adapter.createProxyHandler).toBeDefined();
      expect(adapter.createProxyHandler).toBe(proxyFn);
    });

    test("createProxyHandler invokes the provided proxy function", () => {
      const rawFn = vi.fn();
      const proxyFn = vi.fn().mockReturnValue("proxy-handler");
      const adapter = InngestEndpointAdapter.create(rawFn, proxyFn);

      const mockClient = {} as Inngest.Like;
      const result = adapter.createProxyHandler?.({ client: mockClient });

      expect(proxyFn).toHaveBeenCalledWith({ client: mockClient });
      expect(result).toBe("proxy-handler");
    });
  });

  describe("Like interface", () => {
    test("adapter satisfies Like interface", () => {
      const rawFn = vi.fn();
      const adapter = InngestEndpointAdapter.create(rawFn);

      // Verify it has the required Like interface properties
      expect(typeof adapter).toBe("function");
      expect(adapter[Symbol.toStringTag]).toBe(InngestEndpointAdapter.Tag);
      expect(typeof adapter.withOptions).toBe("function");
    });
  });
});
