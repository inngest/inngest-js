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

      return {
        url,
        env,
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
              data: (await req.json()) as Record<string, unknown>,
              fnId: url.searchParams.get(queryKeys.FnId) as string,
              stepId: url.searchParams.get(queryKeys.StepId) as string,
              signature: req.headers.get(headerKeys.Signature) || undefined,
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              isIntrospection: url.searchParams.has(queryKeys.Introspect),
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
