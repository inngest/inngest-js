import * as ExpressHandler from "@local/express";
import { type VercelRequest, type VercelRequestQuery } from "@vercel/node";
import { testFramework } from "./__test__/helpers";

testFramework("Express", ExpressHandler);

testFramework("Express (Vercel)", ExpressHandler, {
  transformReq: (expressReq, res) => {
    const req: Partial<VercelRequest> = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      body: expressReq.body,
      headers: expressReq.headers,
      query: expressReq.query as VercelRequestQuery,
      method: expressReq.method,
      url: expressReq.url,
    };

    return [req, res];
  },
});
