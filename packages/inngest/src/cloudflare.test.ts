import fetch, { Headers, Response } from "cross-fetch";
import * as CloudflareHandler from "./cloudflare.ts";
import { testFramework } from "./test/helpers.ts";

const originalProcess = process;
const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("Cloudflare", CloudflareHandler, {
  lifecycleChanges: () => {
    beforeEach(() => {
      vi.resetModules();

      /**
       * Fake lack of any `process` global var; Cloudflare allows access to env
       * vars by passing them in to the request handler.
       *
       * Because of some test components (mainly `debug`) that use
       * `process.stderr`, we do need to provide some pieces of this, but we can
       * still remove any env vars.
       */
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      process.env = undefined as any;

      Object.defineProperties(globalThis, {
        fetch: { value: fetch, configurable: true },
        Response: { value: Response, configurable: true },
        Headers: { value: Headers, configurable: true },
      });
    });

    afterEach(() => {
      /**
       * Reset all changes made to the global scope
       */
      process.env = originalProcess.env;
      Object.defineProperties(globalThis, {
        fetch: { value: originalFetch, configurable: true },
        Response: { value: originalResponse, configurable: true },
        Headers: { value: originalHeaders, configurable: true },
      });
    });
  },
  transformReq: (req, _res, env) => {
    const headers = new Headers();
    // biome-ignore lint/complexity/noForEach: <explanation>
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (req as any).headers = headers;
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (req as any).json = () => Promise.resolve(req.body);

    return [
      {
        request: req,
        env,
      },
    ];
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
  envTests: () => {
    test("process should be undefined", () => {
      expect(process.env).toBeUndefined();
    });
  },
  handlerTests: () => {
    test.todo("should return a function");
  },
});
