import fetch, { Headers, Response } from "cross-fetch";
import * as EdgeHandler from "./edge";
import { testFramework } from "./test/helpers";

const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("Edge", EdgeHandler, {
  lifecycleChanges: () => {
    beforeEach(() => {
      jest.resetModules();

      /**
       * Fake a global `fetch` value, which is available as as a Web Standard
       * API.
       */
      globalThis.fetch = fetch;

      /**
       * Fake a global `Response` class, which is used to create new responses
       * for the handler.
       */
      globalThis.Response = Response;

      /**
       * Fake a global `Headers` class, which is used to create new Headers
       * objects during response building.
       */
      globalThis.Headers = Headers;
    });

    afterEach(() => {
      /**
       * Reset all changes made to the global scope
       */
      globalThis.fetch = originalFetch;
      globalThis.Response = originalResponse;
      globalThis.Headers = originalHeaders;
    });
  },
  transformReq: (req) => {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (req as any).headers = headers;

    return [req];
  },
  transformRes: async (res, ret: Response) => {
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
