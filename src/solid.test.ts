import { Headers } from "cross-fetch";
import * as SolidHandler from "./solid";
import { testFramework } from "./test/helpers";

testFramework("Solid", SolidHandler, {
  transformReq: (req, _res, _env, serve) => {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      headers.set(k, v as string);
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (req as any).headers = headers;

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      return serve[req.method]({
        env: {
          manifest: true,
        },
        request: req,
      });
    };
  },

  // eslint-disable-next-line @typescript-eslint/require-await
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
