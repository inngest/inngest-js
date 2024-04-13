import * as HonoHandler from "@local/hono";
import { testFramework } from "./test/helpers";

testFramework("Hono", HonoHandler, {
  transformReq: (req) => {
    const c = {
      req: {
        url: req.url,
        query: (key: string) =>
          new URLSearchParams(req.url.split("?")[1] || "").get(key),
        header: (key: string) => req.headers[key] as string,
        method: req.method,
        json: Promise.resolve(req.body),
      },
    };
    return [c];
  },
});
