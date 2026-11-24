import fetch, { Headers, Response } from "cross-fetch";
import nock from "nock";
import * as HonoHandler from "./hono.ts";
import { createClient, testFramework } from "./test/helpers.ts";

const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("Hono", HonoHandler, {
  /**
   * Make sure this stuff is available for all polyfilled Node environments.
   */
  lifecycleChanges: () => {
    beforeEach(() => {
      vi.resetModules();
      Object.defineProperties(globalThis, {
        /**
         * Fake a global `fetch` value, which is available as as a Web Standard
         * API.
         */
        fetch: { value: fetch, configurable: true },
        /**
         * Fake a global `Response` class, which is used to create new responses
         * for the handler.
         */
        Response: { value: Response, configurable: true },
        /**
         * Fake a global `Headers` class, which is used to create new Headers
         * objects during response building.
         */
        Headers: { value: Headers, configurable: true },
      });
    });
    afterEach(() => {
      /**
       * Reset all changes made to the global scope
       */
      Object.defineProperties(globalThis, {
        fetch: { value: originalFetch, configurable: true },
        Response: { value: originalResponse, configurable: true },
        Headers: { value: originalHeaders, configurable: true },
      });
    });
  },
  transformReq: (req) => {
    const c = {
      req: {
        // in practice, this is an absolute URL
        url: new URL(`https://${req.headers["host"]}${req.url}`).href,
        query: (key: string) =>
          new URLSearchParams(req.url.split("?")[1] || "").get(key),
        header: (key: string) => req.headers[key] as string,
        method: req.method,
        text: () =>
          Promise.resolve(
            req.body === undefined ? "" : JSON.stringify(req.body),
          ),
      },
      body: (data: BodyInit, init: ResponseInit) => new Response(data, init),
    };
    return [c];
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

describe("Hono handler URL behind a proxy", () => {
  const devServerUrl = "http://localhost:8288";

  /**
   * Build a minimal Hono-like context, mirroring how `@hono/node-server`
   * exposes `c.req.url` (built from the socket, so `http://` when TLS is
   * terminated upstream) alongside the request headers.
   */
  const createContext = (url: string, headers: Record<string, string>) => {
    const lowerHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );

    return {
      req: {
        url,
        query: () => undefined,
        header: (key: string) => lowerHeaders[key.toLowerCase()],
        method: "PUT",
        text: () => Promise.resolve(""),
      },
      body: (data: BodyInit, init: ResponseInit) => new Response(data, init),
    };
  };

  /**
   * Sync via a PUT and return the URL the SDK registered with the dev server.
   */
  const syncAndGetRegisteredUrl = async (
    reqUrl: string,
    headers: Record<string, string>,
    serveOptions: Partial<Parameters<typeof HonoHandler.serve>[0]> = {},
  ): Promise<string | undefined> => {
    let registeredUrl: string | undefined;

    nock(devServerUrl)
      .post("/fn/register", (body: { url?: string }) => {
        registeredUrl = body.url;
        return true;
      })
      .reply(200, { status: 200 });

    const handler = HonoHandler.serve({
      client: createClient({ id: "test", isDev: true, fetch }),
      functions: [],
      ...serveOptions,
    });

    const res = await handler(
      createContext(reqUrl, {
        host: "my-app.example.com",
        ...headers,
      }) as unknown as Parameters<typeof handler>[0],
    );

    expect(res.status).toBe(200);

    return registeredUrl;
  };

  beforeEach(() => {
    Object.defineProperties(globalThis, {
      fetch: { value: fetch, configurable: true },
      Response: { value: Response, configurable: true },
      Headers: { value: Headers, configurable: true },
    });

    try {
      nock.activate();
    } catch {
      // no-op - already active
    }
  });

  afterEach(() => {
    nock.restore();
    nock.cleanAll();

    Object.defineProperties(globalThis, {
      fetch: { value: originalFetch, configurable: true },
      Response: { value: originalResponse, configurable: true },
      Headers: { value: originalHeaders, configurable: true },
    });
  });

  test("uses X-Forwarded-Proto for an absolute http:// request URL", async () => {
    const url = await syncAndGetRegisteredUrl(
      "http://my-app.example.com/api/inngest",
      { "x-forwarded-proto": "https" },
    );

    expect(url).toBe("https://my-app.example.com/api/inngest");
  });

  test("uses the first value of a multi-hop X-Forwarded-Proto", async () => {
    const url = await syncAndGetRegisteredUrl(
      "http://my-app.example.com/api/inngest",
      { "x-forwarded-proto": "HTTPS, http" },
    );

    expect(url).toBe("https://my-app.example.com/api/inngest");
  });

  test("uses X-Forwarded-Proto for a relative request URL", async () => {
    const url = await syncAndGetRegisteredUrl("/api/inngest", {
      "x-forwarded-proto": "https",
    });

    expect(url).toBe("https://my-app.example.com/api/inngest");
  });

  test("keeps the request URL scheme without X-Forwarded-Proto", async () => {
    const url = await syncAndGetRegisteredUrl(
      "http://my-app.example.com/api/inngest",
      {},
    );

    expect(url).toBe("http://my-app.example.com/api/inngest");
  });

  test("ignores an invalid X-Forwarded-Proto value", async () => {
    const url = await syncAndGetRegisteredUrl(
      "http://my-app.example.com/api/inngest",
      { "x-forwarded-proto": "javascript" },
    );

    expect(url).toBe("http://my-app.example.com/api/inngest");
  });

  test("serveOrigin still takes precedence over X-Forwarded-Proto", async () => {
    const url = await syncAndGetRegisteredUrl(
      "http://my-app.example.com/api/inngest",
      { "x-forwarded-proto": "https" },
      { serveOrigin: "http://override.example.com" },
    );

    expect(url).toBe("http://override.example.com/api/inngest");
  });
});
