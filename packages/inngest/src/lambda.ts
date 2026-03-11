/**
 * An adapter for AWS Lambda to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 *
 * ```ts
 * import { Inngest } from "inngest";
 * import { serve } from "inngest/lambda";
 *
 * const inngest = new Inngest({ id: "my-lambda-app" });
 *
 * const fn = inngest.createFunction(
 *   { id: "hello-world" },
 *   { event: "test/hello.world" },
 *   async ({ event }) => {
 *    return "Hello World";
 *  }
 * );
 *
 * export const handler = serve({ client: inngest, functions: [fn] });
 * ```
 *
 * @module
 */

import type {
  APIGatewayEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import type { Inngest } from "./components/Inngest.ts";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
  type SyncHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { handleDurableEndpointProxyRequest } from "./components/InngestDurableEndpointProxy.ts";
import { InngestEndpointAdapter } from "./components/InngestEndpointAdapter.ts";
import type { Either } from "./helpers/types.ts";
import type { RegisterOptions, SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "aws-lambda";

/**
 * The handler type for AWS Lambda with API Gateway (v1 or v2).
 */
export type LambdaHandler = (
  event: Either<APIGatewayEvent, APIGatewayProxyEventV2>,
  context: Context,
) => Promise<APIGatewayProxyResult>;

/**
 * Detect whether the incoming Lambda event is API Gateway v2.
 */
const isV2Event = (
  ev: APIGatewayEvent | APIGatewayProxyEventV2,
): ev is APIGatewayProxyEventV2 => {
  return (ev as APIGatewayProxyEventV2).version === "2.0";
};

/**
 * Shared comm handler factory used by both `serve()` and `endpointAdapter`.
 */
const commHandler = (
  options: RegisterOptions & { client: Inngest.Like },
  syncOptions?: SyncHandlerOptions,
) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    syncOptions,
    handler: (
      event: Either<APIGatewayEvent, APIGatewayProxyEventV2>,
      _context: Context,
    ) => {
      /**
       * Try to handle multiple incoming event types, as Lambda can have many
       * triggers.
       *
       * This still doesn't handle all cases, but it's a start.
       */
      const eventIsV2 = isV2Event(event);

      // Create a map of headers
      const headersMap = new Map<string, string | undefined>([
        ...Object.entries(event.headers).map(
          ([key, value]) =>
            [key.toLowerCase().trim(), value] as [string, string | undefined],
        ),
      ]);

      const getHeader = (key: string): string | undefined => {
        return headersMap.get(key.toLowerCase().trim());
      };

      return {
        body: () => {
          return JSON.parse(
            event.body
              ? event.isBase64Encoded
                ? Buffer.from(event.body, "base64").toString()
                : event.body
              : "{}",
          );
        },
        headers: getHeader,
        method: () => {
          return eventIsV2
            ? event.requestContext.http.method
            : event.httpMethod;
        },
        url: () => {
          const path = eventIsV2 ? event.requestContext.http.path : event.path;
          const proto = getHeader("x-forwarded-proto") || "https";
          const url = new URL(path, `${proto}://${getHeader("host") || ""}`);

          return url;
        },
        queryString: (key: string) => {
          return event.queryStringParameters?.[key];
        },
        transformResponse: ({
          body,
          status: statusCode,
          headers,
        }): Promise<APIGatewayProxyResult> => {
          return Promise.resolve({ body, statusCode, headers });
        },
        experimentalTransformSyncResponse: async (data: unknown) => {
          const res = data as APIGatewayProxyResult;

          return {
            headers: (res.headers || {}) as Record<string, string>,
            status: res.statusCode,
            body: res.body || "",
          };
        },
      };
    },
  });

  return handler;
};

/**
 * With AWS Lambda, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 *
 * ```ts
 * import { Inngest } from "inngest";
 * import { serve } from "inngest/lambda";
 *
 * const inngest = new Inngest({ id: "my-lambda-app" });
 *
 * const fn = inngest.createFunction(
 *   { id: "hello-world" },
 *   { event: "test/hello.world" },
 *   async ({ event }) => {
 *    return "Hello World";
 *  }
 * );
 *
 * export const handler = serve({ client: inngest, functions: [fn] });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (options: ServeHandlerOptions): LambdaHandler => {
  return commHandler(options).createHandler();
};

/**
 * Creates a durable endpoint proxy handler for AWS Lambda environments.
 *
 * This handler extracts `runId` and `token` from query parameters,
 * fetches the run output from Inngest, decrypts it via middleware
 * (if configured), and returns it with CORS headers.
 */
const createDurableEndpointProxyHandler = (
  options: InngestEndpointAdapter.ProxyHandlerOptions,
): LambdaHandler => {
  return async (
    event: Either<APIGatewayEvent, APIGatewayProxyEventV2>,
    _context: Context,
  ): Promise<APIGatewayProxyResult> => {
    const method = isV2Event(event)
      ? event.requestContext.http.method
      : event.httpMethod;

    const result = await handleDurableEndpointProxyRequest(
      options.client as Inngest.Any,
      {
        runId: event.queryStringParameters?.runId ?? null,
        token: event.queryStringParameters?.token ?? null,
        method,
      },
    );

    return {
      statusCode: result.status,
      headers: result.headers,
      body: result.body,
    };
  };
};

/**
 * In AWS Lambda, create a function that can wrap any endpoint to be able
 * to use steps seamlessly within that API.
 *
 * @example
 * ```ts
 * import { Inngest, step } from "inngest";
 * import { endpointAdapter } from "inngest/lambda";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   endpointAdapter,
 * });
 *
 * // Your durable endpoint Lambda handler
 * export const handler = inngest.endpoint(async (event, context) => {
 *   const result = await step.run("work", () => "done");
 *
 *   return {
 *     statusCode: 200,
 *     body: JSON.stringify({ result }),
 *   };
 * });
 * ```
 *
 * You can also configure a custom redirect URL and create a proxy endpoint:
 *
 * @example
 * ```ts
 * import { Inngest } from "inngest";
 * import { endpointAdapter } from "inngest/lambda";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   endpointAdapter: endpointAdapter.withOptions({
 *     asyncRedirectUrl: "/poll",
 *   }),
 * });
 *
 * // Proxy endpoint Lambda handler - handles CORS and decryption
 * export const pollHandler = inngest.endpointProxy();
 * ```
 */
export const endpointAdapter = InngestEndpointAdapter.create((options) => {
  return commHandler(options, options).createSyncHandler();
}, createDurableEndpointProxyHandler);
