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

import {
  type APIGatewayEvent,
  type APIGatewayProxyEventV2,
  type APIGatewayProxyResult,
  type Context,
} from "aws-lambda";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.js";
import { type Either } from "./helpers/types.js";
import { type SupportedFrameworkName } from "./types.js";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "aws-lambda";

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
export const serve = (
  options: ServeHandlerOptions
): ((
  event: Either<APIGatewayEvent, APIGatewayProxyEventV2>,
  _context: Context
) => Promise<APIGatewayProxyResult>) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      event: Either<APIGatewayEvent, APIGatewayProxyEventV2>,
      _context: Context
    ) => {
      /**
       * Try to handle multiple incoming event types, as Lambda can have many
       * triggers.
       *
       * This still doesn't handle all cases, but it's a start.
       */
      const eventIsV2 = ((
        ev: APIGatewayEvent | APIGatewayProxyEventV2
      ): ev is APIGatewayProxyEventV2 => {
        return (ev as APIGatewayProxyEventV2).version === "2.0";
      })(event);

      return {
        body: () => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return JSON.parse(
            event.body
              ? event.isBase64Encoded
                ? Buffer.from(event.body, "base64").toString()
                : event.body
              : "{}"
          );
        },
        headers: (key) => event.headers[key],
        method: () => {
          return eventIsV2
            ? event.requestContext.http.method
            : event.httpMethod;
        },
        url: () => {
          const path = eventIsV2 ? event.requestContext.http.path : event.path;
          const proto = event.headers["x-forwarded-proto"] || "https";
          const url = new URL(path, `${proto}://${event.headers.host || ""}`);

          return url;
        },
        queryString: (key) => {
          return event.queryStringParameters?.[key];
        },
        transformResponse: ({
          body,
          status: statusCode,
          headers,
        }): Promise<APIGatewayProxyResult> => {
          return Promise.resolve({ body, statusCode, headers });
        },
      };
    },
  });

  return handler.createHandler();
};
