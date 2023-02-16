import * as RedwoodHandler from "./redwood";
import { testFramework } from "./test/helpers";

testFramework("Redwood.js", RedwoodHandler, {
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

  // eslint-disable-next-line @typescript-eslint/require-await
  transformRes: async (res, ret: RedwoodHandler.RedwoodResponse) => {
    return {
      status: ret.statusCode,
      body: ret.body || "",
      headers: ret.headers || {},
    };
  },
});
