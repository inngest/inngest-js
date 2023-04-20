import type {
  APIGatewayEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";

export const name = "aws-lambda";

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
 * const inngest = new Inngest({ name: "My Lambda App" });
 *
 * const fn = inngest.createFunction(
 *   { name: "Hello World" },
 *   { event: "test/hello.world" },
 *   async ({ event }) => {
 *     return "Hello World";
 *   }
 * );
 *
 * export const handler = serve(inngest, [fn]);
 * ```
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    name,
    nameOrInngest,
    fns,
    { ...opts },
    (event: APIGatewayEvent | APIGatewayProxyEventV2, _context: Context) => {
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

      const method = eventIsV2
        ? event.requestContext.http.method
        : event.httpMethod;
      const path = eventIsV2 ? event.requestContext.http.path : event.path;

      let url: URL;

      try {
        const proto = event.headers["x-forwarded-proto"] || "https";
        url = new URL(path, `${proto}://${event.headers.host || ""}`);
      } catch (err) {
        throw new Error("Could not parse URL from `event.headers.host`");
      }

      return {
        url,
        register: () => {
          if (method === "PUT") {
            return {
              deployId: event.queryStringParameters?.[
                queryKeys.DeployId
              ] as string,
            };
          }
        },

        run: () => {
          if (method === "POST") {
            return {
              data: JSON.parse(
                event.body
                  ? event.isBase64Encoded
                    ? Buffer.from(event.body, "base64").toString()
                    : event.body
                  : "{}"
              ) as Record<string, unknown>,
              fnId: event.queryStringParameters?.[queryKeys.FnId] as string,
              stepId: event.queryStringParameters?.[queryKeys.StepId] as string,
              signature: event.headers[headerKeys.Signature] as string,
            };
          }
        },

        view: () => {
          if (method === "GET") {
            return {
              isIntrospection: Object.hasOwnProperty.call(
                event.queryStringParameters || {},
                queryKeys.Introspect
              ),
            };
          }
        },
      };
    },

    ({ body, status, headers }, _req): Promise<APIGatewayProxyResult> => {
      return Promise.resolve({
        body,
        statusCode: status,
        headers,
      } as APIGatewayProxyResult);
    }
  );

  return handler.createHandler();
};
