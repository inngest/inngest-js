import * as RemixHandler from "@local/remix";
import { Headers } from "cross-fetch";
import { headerKeys } from "./helpers/consts";
import { testFramework } from "./test/helpers";

testFramework("Remix", RemixHandler, {
  transformReq: (req) => {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    (req as any).headers = headers;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    (req as any).json = () => {
      // Try and parse the body as JSON - this forces an error case where
      // `req.json()` throws an error if the body is not valid JSON and ensures
      // that we are correctly handling requests with no data like some PUTs.
      if (req.method === "PUT" && !headers.has(headerKeys.ContentLength)) {
        throw new Error("Unexpected input error");
      }

      return Promise.resolve(req.body);
    };

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
