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
 * @example Next.js <=12 or the pages router can export the handler directly
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
      expectedReq: NextRequest,
      res: NextApiResponse
    ) => {
      const req = expectedReq as Either<NextApiRequest, NextRequest>;

      const isEdge = isNextEdgeRequest(req);

      const getHeader = (key: string): string | null | undefined => {
        if (isEdge) {
          const header = req.headers.get(key);
          debug(`isEdge; returning header:`, { [key]: header });
          return header;
        }

        const header = req.headers[key];
        debug(`isNotEdge; returning header:`, { [key]: header });
        return Array.isArray(header) ? header[0] : header;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debug = (...args: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        options._unsafe_debug ? console.log("_unsafe_debug:", ...args) : null;

      debug("_unsafe_debug:", { isEdge });

      return {
        body: () => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return isEdge ? req.json() : req.body;
        },
        headers: getHeader,
        method: () => {
          /**
           * `req.method`, though types say otherwise, is not available in Next.js
           * 13 {@link https://beta.nextjs.org/docs/routing/route-handlers Route Handlers}.
           *
           * Therefore, we must try to set the method ourselves where we know it.
           */
          const method = reqMethod || req.method || "";
          debug(`Returning method:`, { method });
          return method;
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
            const isProd = process.env.NODE_ENV === "production";
            debug(`Returning isProduction:`, { isProd });
            return isProd;
          } catch (err) {
            // no-op
          }
        },
        queryString: (key, url) => {
          if (isEdge) {
            const value = url.searchParams.get(key);
            debug(`isEdge; returning query string:`, { [key]: value });
            return value;
          }

          const qs = req.query[key];
          debug(`isNotEdge; returning query string:`, { [key]: qs });
          return Array.isArray(qs) ? qs[0] : qs;
        },

        url: () => {
          if (isEdge) {
            const ret = new URL(req.url);
            debug(`isEdge; returning URL:`, {
              "req.url": req.url,
              ret: ret.href,
            });
            return ret;
          }

          let scheme: "http" | "https" = "https";

          try {
            // eslint-disable-next-line @inngest/internal/process-warn
            if (process.env.NODE_ENV === "development") {
              debug(
                `isNotEdge; NODE_ENV is development; setting scheme to http`
              );
              scheme = "http";
            }
          } catch (err) {
            // no-op
          }

          const hostHeader = getHeader("host") ?? "";
          if (!hostHeader) {
            debug("host header is empty...");
          }

          debug(`isNotEdge; returning URL:`, {
            "req.url": req.url,
            scheme: scheme,
            "req.headers.host": hostHeader,
          });

          return new URL(req.url as string, `${scheme}://${hostHeader}`);
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
  const baseFn = handler.createHandler();

  const fn = baseFn.bind(null, undefined);
  type Fn = typeof fn;

  const handlerFn = Object.defineProperties(fn, {
    GET: { value: baseFn.bind(null, "GET") },
    POST: { value: baseFn.bind(null, "POST") },
    PUT: { value: baseFn.bind(null, "PUT") },
  }) as Fn & {
    GET: Fn;
    POST: Fn;
    PUT: Fn;
  };

  return handlerFn;
};
