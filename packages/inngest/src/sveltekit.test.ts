import type { RequestEvent } from "@sveltejs/kit";
import { fromPartial } from "@total-typescript/shoehorn";
import fetch, { Headers, Response } from "cross-fetch";
import * as SvelteKitHandler from "./sveltekit.ts";
import { testFramework } from "./test/helpers.ts";

const originalFetch = globalThis.fetch;
const originalResponse = globalThis.Response;
const originalHeaders = globalThis.Headers;

testFramework("SvelteKit", SvelteKitHandler, {
  lifecycleChanges: () => {
    beforeEach(() => {
      vi.resetModules();

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
      Object.defineProperties(globalThis, {
        fetch: { value: originalFetch, configurable: true },
        Response: { value: originalResponse, configurable: true },
        Headers: { value: originalHeaders, configurable: true },
      });
    });
  },
  transformReq: (req, _res, _env) => {
    const headers = new Headers();
    // biome-ignore lint/complexity/noForEach: intentional
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    const svelteKitReq: Partial<RequestEvent> = {
      request: fromPartial({
        method: req.method,
        url: req.url,
        headers,
        text: () =>
          Promise.resolve(
            req.body === undefined ? "" : JSON.stringify(req.body),
          ),
      }),
    };

    return [svelteKitReq];
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
