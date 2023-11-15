import { type NextApiRequest, type NextApiResponse } from "next";
import { type NextRequest } from "next/server";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { type Either } from "./helpers/types";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "nextjs";

/**
 * Next.js 12 Edge and Next.js 13 requests appear the same, though we
 * still differentiate for Next.js 12 support.
 */
const isNextEdgeOr13Request = (
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

      const is12EdgeOr13 = isNextEdgeOr13Request(req);

      const getHeader = (key: string): string | null | undefined => {
        if (is12EdgeOr13) {
          const header = req.headers.get(key);
          debug(`is12EdgeOr13; returning header:`, { [key]: header });
          return header;
        }

        const header = req.headers[key];
        debug(`isNot12EdgeOr13; returning header:`, { [key]: header });
        return Array.isArray(header) ? header[0] : header;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debug = (...args: any[]) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        options._unsafe_debug ? console.log("_unsafe_debug:", ...args) : null;

      debug("_unsafe_debug:", { is12EdgeOr13 });

      return {
        body: () => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return is12EdgeOr13 ? req.json() : req.body;
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
          if (is12EdgeOr13) {
            const value = url.searchParams.get(key);
            debug(`is12EdgeOr13; returning query string:`, { [key]: value });
            return value;
          }

          const qs = req.query[key];
          debug(`isNot12EdgeOr13; returning query string:`, { [key]: qs });
          return Array.isArray(qs) ? qs[0] : qs;
        },

        url: () => {
          if (is12EdgeOr13) {
            /**
             * `req.url` here should be the full URL, including query string.
             * There are some caveats, however, where Next.js will obfuscate
             * the host. For example, in the case of `host.docker.internal`,
             * Next.js will instead set the host here to `localhost`.
             *
             * To avoid this, we'll try to parse the URL from `req.url`, but
             * also use the `host` header if it's available.
             */
            let url = new URL(req.url);

            const host = options.serveHost || getHeader("host");
            if (host) {
              const hostWithProtocol = host.includes("://")
                ? host
                : `${url.protocol}//${host}`;

              url = new URL(url, hostWithProtocol);
            }

            debug(`is12EdgeOr13; returning URL:`, {
              "req.url": req.url,
              host,
              url: url.href,
            });

            return url;
          }

          debug(`isNot12EdgeOr13 when returning URL`);

          let scheme: "http" | "https" = "https";
          const host = options.serveHost || getHeader("host") || "";

          try {
            // eslint-disable-next-line @inngest/internal/process-warn
            if (process.env.NODE_ENV === "development") {
              debug(
                `isNot12EdgeOr13; NODE_ENV is development; setting scheme to http`
              );
              scheme = "http";
            }
          } catch (err) {
            // no-op
          }

          const url = new URL(req.url as string, `${scheme}://${host}`);

          debug(`isNot12EdgeOr13; returning URL:`, {
            "req.url": req.url,
            host,
            url: url.href,
          });

          return url;
        },
        transformResponse: ({ body, headers, status }): Response => {
          if (isNextEdgeOr13Request(req)) {
            return new Response(body, { status, headers });
          }

          for (const [key, value] of Object.entries(headers)) {
            res.setHeader(key, value);
          }

          res.status(status).send(body);

          /**
           * Next.js 13 requires that the return value is always `Response`,
           * though this serve handler can't understand if we're using 12 or 13.
           *
           * 12 doesn't seem to care if we also return a response from the
           * handler, so we'll just return `undefined` here, which will be safe
           * at runtime and enforce types for use with Next.js 13.
           */
          return undefined as unknown as Response;
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
