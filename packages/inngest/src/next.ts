/**
 * An adapter for Next.js to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * Supports Next.js 12+, both serverless and edge.
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
 * @module
 */

import { type NextApiRequest, type NextApiResponse } from "next";
import { type NextRequest } from "next/server.js";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { getResponse } from "./helpers/env";
import { type Either } from "./helpers/types";
import { type SupportedFrameworkName } from "./types";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "nextjs";

/**
 * In Next.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * Supports Next.js 12+, both serverless and edge.
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

      const getHeader = (key: string): string | null | undefined => {
        const header =
          typeof req.headers.get === "function"
            ? req.headers.get(key)
            : req.headers[key];

        return Array.isArray(header) ? header[0] : header;
      };

      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        body: () => (typeof req.json === "function" ? req.json() : req.body),
        headers: getHeader,
        method: () => {
          /**
           * `req.method`, though types say otherwise, is not available in Next.js
           * 13 {@link https://beta.nextjs.org/docs/routing/route-handlers Route Handlers}.
           *
           * Therefore, we must try to set the method ourselves where we know it.
           */
          const method = reqMethod || req.method || "";
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
            return isProd;
          } catch (err) {
            // no-op
          }
        },
        queryString: (key, url) => {
          const qs = req.query?.[key] || url.searchParams.get(key);
          return Array.isArray(qs) ? qs[0] : qs;
        },

        url: () => {
          let absoluteUrl: URL | undefined;
          try {
            absoluteUrl = new URL(req.url as string);
          } catch {
            // no-op
          }

          if (absoluteUrl) {
            /**
             * `req.url` here should may be the full URL, including query string.
             * There are some caveats, however, where Next.js will obfuscate
             * the host. For example, in the case of `host.docker.internal`,
             * Next.js will instead set the host here to `localhost`.
             *
             * To avoid this, we'll try to parse the URL from `req.url`, but
             * also use the `host` header if it's available.
             */
            const host = options.serveHost || getHeader("host");
            if (host) {
              const hostWithProtocol = new URL(
                host.includes("://") ? host : `${absoluteUrl.protocol}//${host}`
              );

              absoluteUrl.protocol = hostWithProtocol.protocol;
              absoluteUrl.host = hostWithProtocol.host;
              absoluteUrl.port = hostWithProtocol.port;
              absoluteUrl.username = hostWithProtocol.username;
              absoluteUrl.password = hostWithProtocol.password;
            }

            return absoluteUrl;
          }

          let scheme: "http" | "https" = "https";
          const host = options.serveHost || getHeader("host") || "";

          try {
            // eslint-disable-next-line @inngest/internal/process-warn
            if (process.env.NODE_ENV === "development") {
              scheme = "http";
            }
          } catch (err) {
            // no-op
          }

          const url = new URL(req.url as string, `${scheme}://${host}`);

          return url;
        },
        transformResponse: ({ body, headers, status }): Response => {
          /**
           * Carefully attempt to set headers and data on the response object
           * for Next.js 12 support.
           */
          if (typeof res?.setHeader === "function") {
            for (const [key, value] of Object.entries(headers)) {
              res.setHeader(key, value);
            }
          }

          if (
            typeof res?.status === "function" &&
            typeof res?.send === "function"
          ) {
            res.status(status).send(body);

            /**
             * If we're here, we're in a serverless endpoint (not edge), so
             * we've correctly sent the response and can return `undefined`.
             *
             * Next.js 13 edge requires that the return value is typed as
             * `Response`, so we still enforce that as we cannot dynamically
             * adjust typing based on the environment.
             */
            return undefined as unknown as Response;
          }

          /**
           * If we're here, we're in an edge environment and need to return a
           * `Response` object.
           *
           * We also don't know if the current environment has a native
           * `Response` object, so we'll grab that first.
           */
          const Res = getResponse();
          return new Res(body, { status, headers });
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
