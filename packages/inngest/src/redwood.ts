import {
  type APIGatewayProxyEvent,
  type Context as LambdaContext,
} from "aws-lambda";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { processEnv } from "./helpers/env";
import { type SupportedFrameworkName } from "./types";

export interface RedwoodResponse {
  statusCode: number;
  body?: string | null;
  headers?: Record<string, string>;
}

export const frameworkName: SupportedFrameworkName = "redwoodjs";

/**
 * In Redwood.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (event: APIGatewayProxyEvent, _context: LambdaContext) => {
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
        method: () => event.httpMethod,
        url: () => {
          const scheme =
            processEnv("NODE_ENV") === "development" ? "http" : "https";
          const url = new URL(
            event.path,
            `${scheme}://${event.headers.host || ""}`
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
      };
    },
  });

  return handler.createHandler();
};
