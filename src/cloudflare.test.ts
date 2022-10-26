import fetch, { Headers, Response } from "cross-fetch";
import * as CloudflareHandler from "./cloudflare";
import { testFramework } from "./test/helpers";

const originalProcess = process;
const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("Cloudflare", CloudflareHandler, {
  lifecycleChanges: () => {
    beforeEach(() => {
      jest.resetModules();

      /**
       * Fake lack of any `process` global var; Cloudflare allows access to env
       * vars by passing them in to the request handler.
       *
       * Because of some test components (mainly `debug`) that use
       * `process.stderr`, we do need to provide some pieces of this, but we can
       * still remove any env vars.
       */
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      process.env = undefined as any;

      /**
       * Fake a global `fetch` value, which is available as the Cloudflare
       * handler will use the global DOM `fetch`.
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
      process.env = originalProcess.env;
      globalThis.fetch = originalFetch;
      globalThis.Response = originalResponse;
      globalThis.Headers = originalHeaders;
    });
  },
  transformReq: (req, res, env) => {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (req as any).headers = headers;

    return [
      {
        request: req,
        env,
      },
    ];
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
  envTests: () => {
    test("process should be undefined", () => {
      expect(process.env).toBeUndefined();
    });
  },
  handlerTests: () => {
    test.todo("should return a function");
  },
});
