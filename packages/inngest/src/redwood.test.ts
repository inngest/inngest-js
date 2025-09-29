import * as RedwoodHandler from "./redwood.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("Redwood.ts", RedwoodHandler, {
  transformReq: (req, _res, _env) => {
    return [
      {
        path: req.path,
        headers: req.headers,
        httpMethod: req.method,
        queryStringParameters: req.query,
        body:
          typeof req.body === "string" ? req.body : JSON.stringify(req.body),
      },
      {},
    ];
  },

  transformRes: async (_args, ret: RedwoodHandler.RedwoodResponse) => {
    return {
      status: ret.statusCode,
      body: ret.body || "",
      headers: ret.headers || {},
    };
  },
});
