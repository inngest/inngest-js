import fetch, { Headers, Response } from "cross-fetch";
import { testFramework } from "../test/helpers.ts";
import * as DenoFreshHandler from "./fresh.ts";

const originalProcess = process;
const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("Deno Fresh", DenoFreshHandler, {
  lifecycleChanges: () => {
    beforeEach(() => {
      vi.resetModules();

      /**
       * Fake lack of any `process` global var; Deno allows access to env vars
       * via the `Deno.env` object, but we mask that and pass it in as an object
       * in the serve handler.
       *
       * Because of some test components (mainly `debug`) that use
       * `process.stderr`, we do need to provide some pieces of this, but we can
       * still remove any env vars.
       */
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      process.env = undefined as any;

      Object.defineProperties(globalThis, {
        fetch: { value: fetch, configurable: true },
        Response: { value: Response, configurable: true },
        Headers: { value: Headers, configurable: true },
      });

      /**
       * Fake a global Deno object, which is primarily used to access env vars.
       */
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      (globalThis as any).Deno = {
        env: { toObject: () => originalProcess.env },
      };
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
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      delete (globalThis as any).Deno;
    });
  },

  transformReq: (req, _res, env) => {
    const headers = new Headers();
    // biome-ignore lint/complexity/noForEach: intentional
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    (req as any).headers = headers;
    // biome-ignore lint/suspicious/noExplicitAny: intentional
    (req as any).json = () => Promise.resolve(req.body);

    return [req, env];
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

    test("Deno.env.toObject should be defined", () => {
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      expect((globalThis as any).Deno.env.toObject).toBeDefined();
    });
  },
});
