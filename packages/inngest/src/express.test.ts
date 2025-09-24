import type { VercelRequest, VercelRequestQuery } from "@vercel/node";
import * as ExpressHandler from "./express.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("Express", ExpressHandler);

testFramework("Express (Vercel)", ExpressHandler, {
  transformReq: (expressReq, res) => {
    const req: Partial<VercelRequest> = {
      body: expressReq.body,
      headers: expressReq.headers,
      query: expressReq.query as VercelRequestQuery,
      method: expressReq.method,
      url: expressReq.url,
    };

    return [req, res];
  },
});
