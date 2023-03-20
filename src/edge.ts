import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { allProcessEnv } from "./helpers/env";

/**
 * In an edge runtime, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * The edge runtime is a generic term for any serverless runtime that supports
 * only standard Web APIs such as `fetch`, `Request`, and `Response`, such as
 * Cloudflare Workers, Vercel Edge Functions, and AWS Lambda@Edge.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/edge";
 * import fns from "~/inngest";
 *
 * export const handler = serve("My Edge App", fns);
 * ```
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    "edge",
    nameOrInngest,
    fns,
    {
      fetch: fetch.bind(globalThis),
      ...opts,
    },
    (req: Request) => {
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
              deployId: url.searchParams.get(queryKeys.DeployId) as string,
            };
          }
        },
        run: async () => {
          if (req.method === "POST") {
            return {
              data: (await req.json()) as Record<string, unknown>,
              env,
              fnId: url.searchParams.get(queryKeys.FnId) as string,
              isProduction,
              url,
              stepId: url.searchParams.get(queryKeys.StepId) as string,
              signature: req.headers.get(headerKeys.Signature) as string,
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
      return new Response(body, { status, headers });
    }
  );

  return handler.createHandler();
};
