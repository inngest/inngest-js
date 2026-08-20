import { createMockContext } from "@story-health/vitest-koa-mocks";
import type { RequestMethod } from "node-mocks-http";
import * as KoaHandler from "./koa.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("Koa", KoaHandler, {
  transformReq: (req, _res, _env) => {
    const ctx = createMockContext({
      url: `https://${req.headers.host || req.hostname}${req.url}`,
      method: req.method as RequestMethod,
      statusCode: req.statusCode,
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      headers: req.headers as any,
      host: req.hostname,

      requestBody: req.body,
    });

    return [ctx];
  },
  transformRes: (args) => {
    const ctx = args[0] as ReturnType<typeof createMockContext>;

    return Promise.resolve({
      status: ctx.status,
      body: ctx.body as string,
      headers: ctx.response.headers as Record<string, string>,
    });
  },
});
