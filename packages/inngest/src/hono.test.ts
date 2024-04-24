import * as HonoHandler from "@local/hono";
import { Response } from "cross-fetch";
import { testFramework } from "./test/helpers";

testFramework("Hono", HonoHandler, {
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
