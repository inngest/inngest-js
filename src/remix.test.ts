import { Headers } from "cross-fetch";
import * as RemixHandler from "./remix";
import { testFramework } from "./test/helpers";

testFramework("Remix", RemixHandler, {
  transformReq: (req) => {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (req as any).headers = headers;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (req as any).json = () => Promise.resolve(req.body);

    return [{ request: req }];
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
