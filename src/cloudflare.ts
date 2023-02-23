import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";

/**
 * In Cloudflare, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    "cloudflare-pages",
    nameOrInngest,
    fns,
    {
      /**
       * Assume that we want to override the `fetch` implementation with the one
       * globally available in the Cloudflare env. Specifying it here will
       * ensure we avoid trying to load a Node-compatible version later.
       */
      fetch: fetch.bind(globalThis),
      ...opts,
    },
    ({
      request: req,
      env,
    }: {
      request: Request;
      env: Record<string, string | undefined>;
    }) => {
      const url = new URL(req.url, `https://${req.headers.get("host") || ""}`);
      const isProduction =
        env.CF_PAGES === "1" || env.ENVIRONMENT === "production";

      return {
        view: () => {
          if (req.method === "GET") {
            return {
              url,
              env,
              isIntrospection: url.searchParams.has(queryKeys.Introspect),
              isProduction,
            };
          }
        },
        register: () => {
          if (req.method === "PUT") {
            return {
              env,
              url,
              isProduction,
              deployId: url.searchParams.get(queryKeys.DeployId),
            };
          }
        },
        run: async () => {
          if (req.method === "POST") {
            return {
              fnId: url.searchParams.get(queryKeys.FnId) as string,
              stepId: url.searchParams.get(queryKeys.StepId) as string,
              data: (await req.json()) as Record<string, any>,
              env,
              isProduction,
              url,
              signature: req.headers.get(headerKeys.Signature) || undefined,
            };
          }
        },
      };
    },
    ({ body, status, headers }): Response => {
      return new Response(body, {
        status,
        headers,
      });
    }
  );

  return handler.createHandler();
};
