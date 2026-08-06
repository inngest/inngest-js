import type { APIGatewayProxyResult } from "aws-lambda";
import { describe, expect, test } from "vitest";
import * as LambdaHandler from "./lambda.ts";
import { buildLambdaUrl } from "./lambda.ts";
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

describe("buildLambdaUrl query string preservation", () => {
  const getHeader = (key: string) =>
    key.toLowerCase() === "host" ? "example.execute-api.us-east-1.amazonaws.com" : undefined;

  test("API Gateway v2 keeps rawQueryString so fnId is on url.searchParams", () => {
    const url = buildLambdaUrl(
      {
        version: "2.0",
        rawQueryString: "fnId=my-app-my-fn&stepId=step",
        headers: { host: "example.execute-api.us-east-1.amazonaws.com" },
        requestContext: {
          http: {
            method: "POST",
            path: "/api/inngest",
          },
        },
      } as Parameters<typeof buildLambdaUrl>[0],
      getHeader,
    );

    expect(url.pathname).toBe("/api/inngest");
    expect(url.searchParams.get("fnId")).toBe("my-app-my-fn");
    expect(url.searchParams.get("stepId")).toBe("step");
  });

  test("API Gateway v1 keeps queryStringParameters on url.searchParams", () => {
    const url = buildLambdaUrl(
      {
        path: "/api/inngest",
        httpMethod: "POST",
        headers: { host: "example.execute-api.us-east-1.amazonaws.com" },
        queryStringParameters: {
          fnId: "my-app-my-fn",
          stepId: "step",
        },
      } as Parameters<typeof buildLambdaUrl>[0],
      getHeader,
    );

    expect(url.searchParams.get("fnId")).toBe("my-app-my-fn");
    expect(url.searchParams.get("stepId")).toBe("step");
  });

  test("omits search when the event has no query string", () => {
    const url = buildLambdaUrl(
      {
        version: "2.0",
        rawQueryString: "",
        headers: { host: "example.execute-api.us-east-1.amazonaws.com" },
        requestContext: {
          http: {
            method: "GET",
            path: "/api/inngest",
          },
        },
      } as Parameters<typeof buildLambdaUrl>[0],
      getHeader,
    );

    expect(url.search).toBe("");
  });
});
