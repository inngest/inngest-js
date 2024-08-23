import * as RedwoodHandler from "@local/redwood";
import { testFramework } from "./__test__/helpers";

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
  transformRes: async (_args, ret: RedwoodHandler.RedwoodResponse) => {
    return {
      status: ret.statusCode,
      body: ret.body || "",
      headers: ret.headers || {},
    };
  },
});
