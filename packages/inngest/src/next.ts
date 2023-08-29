import { type NextApiRequest, type NextApiResponse } from "next";
import { type NextRequest } from "next/server";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { type Either } from "./helpers/types";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "nextjs";

const isNextEdgeRequest = (
  req: NextApiRequest | NextRequest
): req is NextRequest => {
  return typeof req?.headers?.get === "function";
};

/**
 * In Next.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @example Next.js <=12 can export the handler directly
 * ```ts
 * export default serve({ client: inngest, functions: [fn1, fn2] });
 * ```
 *
 * @example Next.js >=13 with the `app` dir must export individual methods
 * ```ts
 * export const { GET, POST, PUT } = serve({
 *            client: inngest,
 *            functions: [fn1, fn2],
 * });
 * ```
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      reqMethod: "GET" | "POST" | "PUT" | undefined,
      req: Either<NextApiRequest, NextRequest>,
      res: NextApiResponse
    ) => {
      const isEdge = isNextEdgeRequest(req);

      return {
        body: () => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return isEdge ? req.json() : req.body;
        },
        headers: (key) => {
          if (isEdge) {
            return req.headers.get(key);
          }

          const header = req.headers[key];
          return Array.isArray(header) ? header[0] : header;
        },
        method: () => {
          /**
           * `req.method`, though types say otherwise, is not available in Next.js
           * 13 {@link https://beta.nextjs.org/docs/routing/route-handlers Route Handlers}.
           *
           * Therefore, we must try to set the method ourselves where we know it.
           */
          return reqMethod || req.method || "";
        },
        isProduction: () => {
          /**
           * Vercel Edge Functions do not allow dynamic access to environment
           * variables, so we'll manage production checks directly here.
           *
           * We try/catch to avoid situations where Next.js is being used in
           * environments where `process.env` is not accessible or polyfilled.
           */
          try {
            // eslint-disable-next-line @inngest/internal/process-warn
            return process.env.NODE_ENV === "production";
          } catch (err) {
            // no-op
          }
        },
        queryString: (key, url) => {
          if (isEdge) {
            return url.searchParams.get(key);
          }

          const qs = req.query[key];
          return Array.isArray(qs) ? qs[0] : qs;
        },

        url: () => {
          if (isEdge) {
            return new URL(req.url);
          }

          let scheme: "http" | "https" = "https";

          try {
            // eslint-disable-next-line @inngest/internal/process-warn
            if (process.env.NODE_ENV === "development") {
              scheme = "http";
            }
          } catch (err) {
            // no-op
          }

          return new URL(
            req.url as string,
            `${scheme}://${req.headers.host || ""}`
          );
        },
        transformResponse: ({ body, headers, status }) => {
          if (isNextEdgeRequest(req)) {
            return new Response(body, { status, headers });
          }

          for (const [key, value] of Object.entries(headers)) {
            res.setHeader(key, value);
          }

          res.status(status).send(body);
        },
        transformStreamingResponse: ({ body, headers, status }) => {
          return new Response(body, { status, headers });
        },
      };
    },
  });

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
