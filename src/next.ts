import type { NextApiRequest, NextApiResponse } from "next";
import type { NextRequest } from "next/server";
import type { ServeHandler } from "./components/InngestCommHandler";
import { InngestCommHandler } from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { processEnv } from "./helpers/env";
import type { RegisterOptions, SupportedFrameworkName } from "./types";

export const name: SupportedFrameworkName = "nextjs";

/**
 * In Next.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @example Next.js <=12 can export the handler directly
 * ```ts
 * export default serve(inngest, [fn1, fn2]);
 * ```
 *
 * @example Next.js >=13 with the `app` dir must export individual methods
 * ```ts
 * export const { GET, POST, PUT } = serve(inngest, [fn1, fn2]);
 * ```
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const optsWithFetch: RegisterOptions = { ...opts };

  const handler = new InngestCommHandler(
    name,
    nameOrInngest,
    fns,
    optsWithFetch,
    (
      reqMethod: "GET" | "POST" | "PUT" | undefined,
      req: NextApiRequest | NextRequest,
      _res: NextApiResponse
    ) => {
      /**
       * `req.method`, though types say otherwise, is not available in Next.js
       * 13 {@link https://beta.nextjs.org/docs/routing/route-handlers Route Handlers}.
       *
       * Therefore, we must try to set the method ourselves where we know it.
       */
      const method = reqMethod || req.method;
      if (!method) {
        throw new Error(
          "No method found on request; check that your exports are correct."
        );
      }

      const isEdge = ((req: NextApiRequest | NextRequest): req is NextRequest =>
        typeof req?.headers?.get === "function")(req);

      const url = isEdge
        ? new URL(req.url)
        : new URL(
            req.url as string,
            `${processEnv("NODE_ENV") === "development" ? "http" : "https"}://${
              req.headers.host || ""
            }`
          );

      const getQueryParam = (key: string): string | undefined => {
        return (
          (isEdge ? url.searchParams.get(key) : req.query[key]?.toString()) ??
          undefined
        );
      };

      const hasQueryParam = (key: string): boolean => {
        return (
          (isEdge
            ? url.searchParams.has(key)
            : Object.hasOwnProperty.call(req.query, key)) ?? false
        );
      };

      const getHeader = (key: string): string | undefined => {
        return (
          (isEdge ? req.headers.get(key) : req.headers[key]?.toString()) ??
          undefined
        );
      };

      return {
        url,
        register: () => {
          if (method === "PUT") {
            return {
              deployId: getQueryParam(queryKeys.DeployId)?.toString(),
            };
          }
        },
        run: async () => {
          if (method === "POST") {
            return {
              data: isEdge
                ? ((await req.json()) as Record<string, unknown>)
                : (req.body as Record<string, unknown>),
              fnId: getQueryParam(queryKeys.FnId) as string,
              stepId: getQueryParam(queryKeys.StepId) as string,
              signature: getHeader(headerKeys.Signature) as string,
            };
          }
        },
        view: () => {
          if (method === "GET") {
            return {
              isIntrospection: hasQueryParam(queryKeys.Introspect),
            };
          }
        },
      };
    },
    ({ body, headers, status }, _method, _req, res) => {
      if ("send" in res) {
        for (const [key, value] of Object.entries(headers)) {
          res.setHeader(key, value);
        }

        return void res.status(status).send(body);
      }

      return new Response(body, { status, headers });
    },
    ({ body, headers, status }) => {
      return new Response(body, { status, headers });
    }
  );

  /**
   * Next.js 13 uses
   * {@link https://beta.nextjs.org/docs/routing/route-handlers Route Handlers}
   * to declare API routes instead of a generic catch-all method that was
   * available using the `pages/api` directory.
   *
   * This means that users must now export a function for each method supported
   * by the endpoint. For us, this means requiring a user explicitly exports
   * `GET`, `POST`, and `PUT` functions.
   *
   * Because of this, we'll add circular references to those property names of
   * the returned handler, meaning we can write some succinct code to export
   * them. Thanks, @goodoldneon.
   *
   * @example
   * ```ts
   * export const { GET, POST, PUT } = serve(...);
   * ```
   *
   * See {@link https://beta.nextjs.org/docs/routing/route-handlers}
   */
  const fn = handler.createHandler();

  return Object.defineProperties(fn.bind(null, undefined), {
    GET: { value: fn.bind(null, "GET") },
    POST: { value: fn.bind(null, "POST") },
    PUT: { value: fn.bind(null, "PUT") },
  });
};
