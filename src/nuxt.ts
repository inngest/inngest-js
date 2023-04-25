import type { H3Event } from "h3";
import { getHeader, getMethod, getQuery, readBody, send, setHeaders } from "h3";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { processEnv } from "./helpers/env";
import type { SupportedFrameworkName } from "./types";

export const name: SupportedFrameworkName = "nuxt";

/**
 * In Nuxt 3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    name,
    nameOrInngest,
    fns,
    opts,
    (event: H3Event) => {
      const host = String(getHeader(event, "host"));
      const protocol =
        processEnv("NODE_ENV") === "development" ? "http" : "https";
      const url = new URL(String(event.path), `${protocol}://${host}`);
      const method = getMethod(event);
      const query = getQuery(event);

      return {
        url,
        run: async () => {
          if (method === "POST") {
            return {
              fnId: query[queryKeys.FnId]?.toString() ?? "",
              stepId: query[queryKeys.StepId]?.toString() ?? "",
              signature: getHeader(event, headerKeys.Signature),
              data: await readBody(event),
            };
          }
        },
        register: () => {
          if (method === "PUT") {
            return {
              deployId: query[queryKeys.DeployId]?.toString(),
            };
          }
        },
        view: () => {
          if (method === "GET") {
            return {
              isIntrospection: query && queryKeys.Introspect in query,
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
