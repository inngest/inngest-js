import type { APIGatewayProxyResult } from "aws-lambda";
import * as LambdaHandler from "./lambda.ts";
import { endpointAdapter } from "./lambda.ts";
import { testFramework } from "./test/helpers.ts";
import { testEndpointAdapter } from "./test/testEndpointAdapter.ts";

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

testEndpointAdapter("Lambda", endpointAdapter, {
  invokeProxy: async (client, { url, method }) => {
    const handler = client.endpointProxy();

    const parsedUrl = new URL(url);

    // Build query string parameters from the URL
    const queryStringParameters: Record<string, string> = {};
    parsedUrl.searchParams.forEach((v, k) => {
      queryStringParameters[k] = v;
    });

    // Create a minimal API Gateway v1 event
    const event = {
      path: parsedUrl.pathname,
      headers: { host: parsedUrl.host },
      httpMethod: method,
      queryStringParameters:
        Object.keys(queryStringParameters).length > 0
          ? queryStringParameters
          : null,
      body: null,
      isBase64Encoded: false,
    };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const res = await handler(event as any, {} as any);

    return {
      status: res.statusCode,
      body: res.body || "",
      headers: (res.headers || {}) as Record<string, string>,
    };
  },
});
