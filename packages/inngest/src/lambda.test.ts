import type { APIGatewayProxyResult } from "aws-lambda";
import * as LambdaHandler from "./lambda.ts";
import { testFramework } from "./test/helpers.ts";

testFramework("AWS Lambda", LambdaHandler, {
  transformReq: (req, _res, _env) => {
    return [
      {
        path: req.path,
        // Intentionally make headers uppercase to ensure we test normalizing
        // them for mocked Lambda requests, which do not normalize.
        // See https://github.com/inngest/inngest-js/pull/937
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [
            key.toUpperCase(),
            value,
          ]),
        ),
        httpMethod: req.method,
        queryStringParameters: req.query,
        body:
          typeof req.body === "string" ? req.body : JSON.stringify(req.body),
      },
      {},
    ];
  },

  transformRes: async (_args, retP: Promise<APIGatewayProxyResult>) => {
    const ret = await retP;

    return {
      status: ret.statusCode,
      body: ret.body || "",
      headers: (ret.headers || {}) as Record<string, string>,
    };
  },
});
