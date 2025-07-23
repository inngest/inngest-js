import fetch, { Headers, Response } from "cross-fetch";
import * as HonoHandler from "./hono.ts";
import { testFramework } from "./test/helpers.ts";

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
        json: () => Promise.resolve(req.body),
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
