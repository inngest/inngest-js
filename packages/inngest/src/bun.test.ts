import fetch, { Headers, Response } from "cross-fetch";
import * as BunHandler from "./bun.ts";
import { testFramework } from "./test/helpers.ts";

const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("Bun", BunHandler, {
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
    const headers = new Headers();
    // biome-ignore lint/complexity/noForEach: <explanation>
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (req as any).headers = headers;

    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (req as any).json = () => Promise.resolve(req.body);

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
