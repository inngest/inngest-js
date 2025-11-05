/**
 * An adapter for AWS Lambda to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/redwood";
 * import { inngest } from "src/inngest/client";
 * import fnA from "src/inngest/fnA"; // Your own function
 *
 * export const handler = serve({
 *   client: inngest,
 *   functions: [fnA],
 *   servePath: "/api/inngest",
 * });
 * ```
 *
 * @module
 */

import type {
  APIGatewayProxyEvent,
  Context as LambdaContext,
} from "aws-lambda";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { processEnv } from "./helpers/env.ts";
import type { SupportedFrameworkName } from "./types.ts";

export interface RedwoodResponse {
  statusCode: number;
  body?: string | null;
  headers?: Record<string, string>;
}

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "redwoodjs";

/**
 * In Redwood.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/redwood";
 * import { inngest } from "src/inngest/client";
 * import fnA from "src/inngest/fnA"; // Your own function
 *
 * export const handler = serve({
 *   client: inngest,
 *   functions: [fnA],
 *   servePath: "/api/inngest",
 * });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ((
  event: APIGatewayProxyEvent,
  _context: LambdaContext,
) => Promise<RedwoodResponse>) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (event: APIGatewayProxyEvent, _context: LambdaContext) => {
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
        headers: (key) => event.headers[key],
        method: () => event.httpMethod,
        url: () => {
          const scheme =
            processEnv("NODE_ENV") === "development" ? "http" : "https";
          const url = new URL(
            event.path,
            `${scheme}://${event.headers.host || ""}`,
          );

          return url;
        },
        queryString: (key) => event.queryStringParameters?.[key],
        transformResponse: ({
          body,
          status: statusCode,
          headers,
        }): RedwoodResponse => {
          return { body, statusCode, headers };
        },
        transformSyncRequest: null,
        transformSyncResponse: null,
      };
    },
  });

  return handler.createHandler();
};
