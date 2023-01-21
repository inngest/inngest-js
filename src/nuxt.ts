import type { H3Event } from "h3";
import { readBody, setHeaders, send, getMethod, getQuery, getHeader } from "h3";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { queryKeys } from "./helpers/consts";
import { allProcessEnv } from "./helpers/env";

/**
 * In Nuxt 3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    "nuxt",
    nameOrInngest,
    fns,
    opts,
    (event: H3Event) => {
      const env = allProcessEnv();
      const host = String(getHeader(event, "host"));
      const protocol = env.NODE_ENV === "development" ? "http" : "https";
      const url = new URL(String(event.path), `${protocol}://${host}`);
      const isProduction =
        env.ENVIRONMENT === "production" || env.NODE_ENV === "production";
      const method = getMethod(event);
      const query = getQuery(event);

      return {
        run: async () => {
          if (method === "POST") {
            return {
              fnId: query[queryKeys.FnId]?.toString() ?? "",
              data: await readBody(event),
              env,
              isProduction,
              url,
            };
          }
        },
        register: () => {
          if (method === "PUT") {
            return {
              env,
              url,
              isProduction,
              deployId: query[queryKeys.DeployId]?.toString(),
            };
          }
        },
        view: () => {
          if (method === "GET") {
            return {
              env,
              url,
              isIntrospection: query && queryKeys.Introspect in query,
              isProduction,
            };
          }
        },
      };
    },
    (actionRes, event: H3Event) => {
      const { res } = event.node;
      res.statusCode = actionRes.status;
      setHeaders(event, actionRes.headers);
      return send(event, actionRes.body);
    }
  );

  return handler.createHandler();
};
