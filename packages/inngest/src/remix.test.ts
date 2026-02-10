import { Headers } from "cross-fetch";
import { headerKeys } from "./helpers/consts.ts";
import * as RemixHandler from "./remix.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("Remix", RemixHandler, {
  transformReq: (req) => {
    const headers = new Headers();
    // biome-ignore lint/complexity/noForEach: intentional
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // biome-ignore lint/suspicious/noExplicitAny: intentional
    (req as any).headers = headers;
    // biome-ignore lint/suspicious/noExplicitAny: intentional
    (req as any).text = () =>
      Promise.resolve(req.body === undefined ? "" : JSON.stringify(req.body));

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
