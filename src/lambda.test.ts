import * as LambdaHandler from "@local/lambda";
import { type APIGatewayProxyResult } from "aws-lambda";
import { testFramework } from "./test/helpers";

testFramework("AWS Lambda", LambdaHandler, {
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

  transformRes: async (_res, retP: Promise<APIGatewayProxyResult>) => {
    const ret = await retP;

    return {
      status: ret.statusCode,
      body: ret.body || "",
      headers: (ret.headers || {}) as Record<string, string>,
    };
  },
});
