import fetch, { Headers, Response } from "cross-fetch";
import { testFramework } from "../test/helpers";
import * as DenoFreshHandler from "./fresh";

const originalProcess = process;
const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("Deno Fresh", DenoFreshHandler, {
  lifecycleChanges: () => {
    beforeEach(() => {
      jest.resetModules();

      /**
       * Fake lack of any `process` global var; Deno allows access to env vars
       * via the `Deno.env` object, but we mask that and pass it in as an object
       * in the serve handler.
       *
       * Because of some test components (mainly `debug`) that use
       * `process.stderr`, we do need to provide some pieces of this, but we can
       * still remove any env vars.
       */
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      process.env = undefined as any;

      /**
       * Fake a global `fetch` value, which is available as the Deno handler
       * will use the global DOM `fetch`.
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

      /**
       * Fake a global Deno object, which is primarily used to access env vars.
       */
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (globalThis as any).Deno = {
        env: { toObject: () => originalProcess.env },
      };
    });

    afterEach(() => {
      /**
       * Reset all changes made to the global scope
       */
      process.env = originalProcess.env;
      globalThis.fetch = originalFetch;
      globalThis.Response = originalResponse;
      globalThis.Headers = originalHeaders;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      delete (globalThis as any).Deno;
    });
  },

  transformReq: (req, res, env) => {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (req as any).headers = headers;

    return [req, env];
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

    test("Deno.env.toObject should be defined", () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect((globalThis as any).Deno.env.toObject).toBeDefined();
    });
  },
});
