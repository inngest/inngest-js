import {
  InngestCommHandler,
  ServeHandler,
} from "../components/InngestCommHandler";
import { headerKeys, queryKeys } from "../helpers/consts";

/**
 * With Deno's Fresh framework, serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    "deno/fresh",
    nameOrInngest,
    fns,
    opts,
    (req: Request, env: { [index: string]: string }) => {
      const url = new URL(req.url, `https://${req.headers.get("host") || ""}`);
      const isProduction = Boolean(env.DENO_DEPLOYMENT_ID);

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
              url,
              isProduction,
              signature: req.headers.get(headerKeys.Signature) || undefined,
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              env,
              isIntrospection: url.searchParams.has(queryKeys.Introspect),
              url,
              isProduction,
            };
          }
        },
      };
    },
    ({ body, status, headers }): Response => {
      return new Response(body, { status, headers });
    }
  ).createHandler();

  return (req: Request) => handler(req, Deno.env.toObject());
};

declare const Deno: { env: { toObject: () => { [index: string]: string } } };
