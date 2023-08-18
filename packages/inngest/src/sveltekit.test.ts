import * as SvelteKitHandler from "@local/sveltekit";
import { type RequestEvent } from "@sveltejs/kit";
import { fromPartial } from "@total-typescript/shoehorn";
import { testFramework } from "./test/helpers";

testFramework("SvelteKit", SvelteKitHandler, {
  transformReq: (req, _res, _env) => {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    const svelteKitReq: Partial<RequestEvent> = {
      request: fromPartial({
        url: req.url,
        headers,
        json: () => Promise.resolve(req.body),
      }),
    };

    return [req.method, svelteKitReq];
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
