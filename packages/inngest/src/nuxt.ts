import {
  getHeader,
  getMethod,
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

export const frameworkName: SupportedFrameworkName = "nuxt";

/**
 * In Nuxt 3, serve and register any declared functions with Inngest, making
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
        method: () => getMethod(event),
        url: () => {
          const host = String(getHeader(event, "host"));
          const protocol =
            processEnv("NODE_ENV") === "development" ? "http" : "https";

          const url = new URL(String(event.path), `${protocol}://${host}`);

          return url;
        },
        queryString: (key) => getQuery(event)[key]?.toString(),
        transformResponse: ({ body, status, headers }) => {
          const { res } = event.node;

          res.statusCode = status;
          setHeaders(event, headers);

          return send(event, body);
        },
      };
    },
  });

  return handler.createHandler();
};
