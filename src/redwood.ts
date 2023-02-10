import type {
  APIGatewayProxyEvent,
  Context as LambdaContext,
} from "aws-lambda";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { allProcessEnv } from "./helpers/env";

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
    (event: APIGatewayProxyEvent, _context: LambdaContext) => {
      const env = allProcessEnv();
      const scheme = env.NODE_ENV === "development" ? "http" : "https";
      const url = new URL(
        event.path,
        `${scheme}://${event.headers.host || ""}`
      );
      const isProduction =
        env.VERCEL_ENV === "production" ||
        env.CONTEXT === "production" ||
        env.ENVIRONMENT === "production";

      return {
        register: () => {
          if (event.httpMethod === "PUT") {
            return {
              env,
              isProduction,
              url,
              deployId: event.queryStringParameters?.[queryKeys.DeployId],
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
              env,
              isProduction,
              url,
              data,
              fnId: event.queryStringParameters?.[queryKeys.FnId] as string,
              signature: event.headers[headerKeys.Signature] as string,
              stepId: event.queryStringParameters?.[queryKeys.StepId] as string,
            };
          }
        },
        view: () => {
          if (event.httpMethod === "GET") {
            return {
              env,
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
