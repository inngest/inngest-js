import {
  getHeader,
  getQuery,
  readBody,
  send,
  setHeaders,
  type H3Event,
} from "h3";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { processEnv } from "./helpers/env";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "h3";

/**
 * In h3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (event: H3Event) => {
      return {
        body: () => readBody(event),
        headers: (key) => getHeader(event, key),
        method: () => event.method,
        url: () =>
          new URL(
            String(event.path),
            `${
              processEnv("NODE_ENV") === "development" ? "http" : "https"
            }://${String(getHeader(event, "host"))}`
          ),
        queryString: (key) => String(getQuery(event)[key]),
        transformResponse: (actionRes) => {
          const { res } = event.node;
          res.statusCode = actionRes.status;
          setHeaders(event, actionRes.headers);
          return send(event, actionRes.body);
        },
      };
    },
  });

  return handler.createHandler();
};
