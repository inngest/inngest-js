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

      return {
        env,
        url,
        view: () => {
          if (req.method === "GET") {
            return {
              isIntrospection: url.searchParams.has(queryKeys.Introspect),
            };
          }
        },
        register: () => {
          if (req.method === "PUT") {
            return {
              deployId: url.searchParams.get(queryKeys.DeployId),
            };
          }
        },
        run: async () => {
          if (req.method === "POST") {
            return {
              fnId: url.searchParams.get(queryKeys.FnId) as string,
              stepId: url.searchParams.get(queryKeys.StepId) as string,
              data: (await req.json()) as Record<string, unknown>,
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
