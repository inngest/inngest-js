import http from "node:http";
import {
  createState,
  createTestApp,
  randomSuffix,
  type ServeFactory,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import type { APIGatewayProxyResult, Context } from "aws-lambda";
import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { serve } from "../../../lambda.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

const lambdaContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "test",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
  memoryLimitInMB: "128",
  awsRequestId: "request-id",
  logGroupName: "log-group",
  logStreamName: "log-stream",
  getRemainingTimeInMillis: () => 30_000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

/**
 * Serves through the real Lambda adapter by translating each HTTP request
 * into an API Gateway v2 event.
 */
const createLambdaServer: ServeFactory = ({
  client,
  functions,
  servePath,
  serveOrigin,
}) => {
  const handler = serve({ client, functions, servePath, serveOrigin });

  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("error", (err) => {
      res.writeHead(500);
      res.end(String(err));
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );

      const event: Parameters<typeof handler>[0] = {
        version: "2.0",
        routeKey: "$default",
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(",") : value,
          ]),
        ),
        queryStringParameters: Object.fromEntries(url.searchParams),
        // `Either` intersects the v1 and v2 payloads, so `requestContext`
        // must satisfy both shapes.
        requestContext: {
          accountId: "123456789012",
          apiId: "api-id",
          domainName: url.hostname,
          domainPrefix: "api-id",
          http: {
            method: req.method ?? "GET",
            path: url.pathname,
            protocol: "HTTP/1.1",
            sourceIp: "127.0.0.1",
            userAgent: "test",
          },
          requestId: "request-id",
          routeKey: "$default",
          stage: "$default",
          time: "01/Jan/2026:00:00:00 +0000",
          timeEpoch: 0,
          authorizer: null,
          protocol: "HTTP/1.1",
          httpMethod: req.method ?? "GET",
          identity: {
            accessKey: null,
            accountId: null,
            apiKey: null,
            apiKeyId: null,
            caller: null,
            clientCert: null,
            cognitoAuthenticationProvider: null,
            cognitoAuthenticationType: null,
            cognitoIdentityId: null,
            cognitoIdentityPoolId: null,
            principalOrgId: null,
            sourceIp: "127.0.0.1",
            user: null,
            userAgent: "test",
            userArn: null,
          },
          path: url.pathname,
          requestTimeEpoch: 0,
          resourceId: "resource-id",
          resourcePath: url.pathname,
        },
        body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
        isBase64Encoded: false,
      };

      handler(event, lambdaContext).then(
        (result: APIGatewayProxyResult) => {
          res.writeHead(
            result.statusCode,
            Object.fromEntries(
              Object.entries(result.headers ?? {}).map(([key, value]) => [
                key,
                String(value),
              ]),
            ),
          );
          res.end(result.body ?? "");
        },
        (err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        },
      );
    });
  });
};

test("function-level middleware runs when served via the Lambda adapter", async () => {
  const state = createState({});
  let count = 0;

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onRunStart() {
      count++;
    }
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn-1",
      retries: 0,
      middleware: [MW],
      triggers: [{ event: eventName }],
    },
    async ({ runId }) => {
      state.runId = runId;
    },
  );
  await createTestApp({
    client,
    functions: [fn],
    serve: createLambdaServer,
  });

  await client.send({ name: eventName });
  await state.waitForRunComplete();
  expect(count).toEqual(1);
});
