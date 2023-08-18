import { type RequestEvent } from "@sveltejs/kit";
import {
  InngestCommHandler,
  type ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { processEnv } from "./helpers/env";
import { type SupportedFrameworkName } from "./types";

export const name: SupportedFrameworkName = "sveltekit";

/**
 * Using SvelteKit, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * export const { GET, POST, PUT } = serve(inngest, [fn1, fn2]);
 * ```
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    name,
    nameOrInngest,
    fns,
    opts,
    (method: string, event: RequestEvent) => {
      const protocol =
        processEnv("NODE_ENV") === "development" ? "http" : "https";
      const url = new URL(
        event.request.url,
        `${protocol}://${
          event.request.headers.get("host") || opts?.serveHost || ""
        }`
      );

      return {
        url,
        run: async () => {
          if (method === "POST") {
            return {
              fnId: url.searchParams.get(queryKeys.FnId) as string,
              stepId: url.searchParams.get(queryKeys.StepId) as string,
              data: (await event.request.json()) as Record<string, unknown>,
              signature:
                event.request.headers.get(headerKeys.Signature) || undefined,
            };
          }
        },
        register: () => {
          if (method === "PUT") {
            return {
              deployId: url.searchParams.get(queryKeys.DeployId),
            };
          }
        },
        view: () => {
          if (method === "GET") {
            return {
              isIntrospection: url.searchParams.has(queryKeys.Introspect),
            };
          }
        },
      };
    },
    ({ body, headers, status }): Response => {
      return new Response(body, { status, headers });
    }
  );

  const fn = handler.createHandler();

  return Object.defineProperties(fn.bind(null), {
    GET: { value: fn.bind(null, "GET") },
    POST: { value: fn.bind(null, "POST") },
    PUT: { value: fn.bind(null, "PUT") },
  });
};
