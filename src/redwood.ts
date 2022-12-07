import type {
  APIGatewayProxyEvent,
  Context as LambdaContext,
} from "aws-lambda";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { queryKeys } from "./helpers/consts";

export interface RedwoodResponse {
  statusCode: number;
  body?: string | null;
  headers?: Record<string, string>;
}

/**
 * In Redwood.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts): any => {
  const handler = new InngestCommHandler(
    "redwoodjs",
    nameOrInngest,
    fns,
    opts,
    (event: APIGatewayProxyEvent, context: LambdaContext) => {
      const scheme = process.env.NODE_ENV === "development" ? "http" : "https";
      const url = new URL(
        event.path,
        `${scheme}://${event.headers.host || ""}`
      );
      const isProduction =
        process.env.VERCEL_ENV === "production" ||
        process.env.CONTEXT === "production" ||
        process.env.ENVIRONMENT === "production";

      return {
        register: () => {
          if (event.httpMethod === "PUT") {
            return {
              env: process.env,
              isProduction,
              url,
            };
          }
        },
        run: () => {
          if (event.httpMethod === "POST") {
            /**
             * Some requests can be base64 encoded, requiring us to decode it
             * first before parsing as JSON.
             */
            const data = JSON.parse(
              event.body
                ? event.isBase64Encoded
                  ? Buffer.from(event.body, "base64").toString()
                  : event.body
                : "{}"
            ) as Record<string, any>;

            return {
              env: process.env,
              isProduction,
              url,
              data,
              fnId: event.queryStringParameters?.[queryKeys.FnId] as string,
            };
          }
        },
        view: () => {
          if (event.httpMethod === "GET") {
            return {
              env: process.env,
              isProduction,
              url,
              isIntrospection: Object.hasOwnProperty.call(
                event.queryStringParameters,
                queryKeys.Introspect
              ),
            };
          }
        },
      };
    },
    (actionRes): RedwoodResponse => {
      return {
        statusCode: actionRes.status,
        body: actionRes.body,
        headers: actionRes.headers,
      };
    }
  );

  return handler.createHandler();
};
