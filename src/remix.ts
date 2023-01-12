import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { queryKeys } from "./helpers/consts";
import { allProcessEnv } from "./helpers/env";

/**
 * In Remix, serve and register any declared functions with Inngest, making them
 * available to be triggered by events.
 *
 * Remix requires that you export both a "loader" for serving `GET` requests,
 * and an "action" for serving other requests, therefore exporting both is
 * required.
 *
 * See {@link https://remix.run/docs/en/v1/guides/resource-routes}
 *
 * @example
 * ```ts
 * import { serve } from "inngest/remix";
 * import fns from "~/inngest";
 *
 * const handler = serve("My Remix App", fns);
 *
 * export { handler as loader, handler as action };
 * ```
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts): any => {
  const handler = new InngestCommHandler(
    "remix",
    nameOrInngest,
    fns,
    opts,
    ({ request: req }: { request: Request }) => {
      const env = allProcessEnv();
      const url = new URL(req.url, `https://${req.headers.get("host") || ""}`);
      const isProduction =
        env.VERCEL_ENV === "production" ||
        env.CONTEXT === "production" ||
        env.ENVIRONMENT === "production";

      return {
        register: () => {
          if (req.method === "PUT") {
            return {
              env,
              isProduction,
              url,
              deployId: url.searchParams.get(queryKeys.DeployId),
            };
          }
        },
        run: async () => {
          if (req.method === "POST") {
            return {
              data: (await req.json()) as Record<string, any>,
              env,
              fnId: url.searchParams.get(queryKeys.FnId) as string,
              stepId: url.searchParams.get(queryKeys.StepId) as string,
              isProduction,
              url,
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              env,
              isIntrospection: url.searchParams.has(queryKeys.Introspect),
              isProduction,
              url,
            };
          }
        },
      };
    },
    ({ body, status, headers }): Response => {
      /**
       * If `Response` isn't included in this environment, it's probably a Node
       * env that isn't already polyfilling. In this case, we can polyfill it
       * here to be safe.
       */
      let Res: typeof Response;

      if (typeof Response === "undefined") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-var-requires
        Res = require("cross-fetch").Response;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        Res = Response;
      }

      return new Res(body, {
        status,
        headers,
      });
    }
  );

  return handler.createHandler();
};
