import * as KoaHandler from "@local/koa";
import { createMockContext } from "@shopify/jest-koa-mocks";
import { type Dictionary } from "@shopify/jest-koa-mocks/build/ts/create-mock-cookies";
import { type RequestMethod } from "node-mocks-http";
import { testFramework } from "./test/helpers";

testFramework("Koa", KoaHandler, {
  transformReq: (req, _res, _env) => {
    const ctx = createMockContext({
      url: `https://${req.headers.host || req.hostname}${req.url}`,
      method: req.method as RequestMethod,
      statusCode: req.statusCode,
      headers: req.headers as Dictionary<string>,
      host: req.hostname,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      requestBody: req.body,
    });

    return [ctx];
  },
  transformRes: (res, args, _ret) => {
    const ctx = args[0] as ReturnType<typeof createMockContext>;

    return {
      status: ctx.status,
      body: ctx.body as string,
      headers: ctx.response.headers as Record<string, string>,
    };
  },
});
