import * as AstroHandler from "@local/astro";
import fetch, { Headers, Response } from "cross-fetch";
import { testFramework } from "./test/helpers";

const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("Astro", AstroHandler, {
  /**
   * Make sure this stuff is available for all polyfilled Node environments.
   */
  lifecycleChanges: () => {
    beforeEach(() => {
      jest.resetModules();
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
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    (req as any).headers = headers;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    (req as any).json = () => Promise.resolve(req.body);
    return [{ request: req }];
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
