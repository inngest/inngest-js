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

import type { NextApiRequest, NextApiResponse } from "next";
import type { NextRequest } from "next/server";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { getResponse } from "./helpers/env.ts";
import type { Either } from "./helpers/types.ts";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "nextjs";

/**
 * The shape of a request handler, supporting Next.js 12+.
 *
 * We are intentionally abstract with the arguments here, as Next.js's type
 * checking when building varies wildly between major versions; specifying
 * different types (even optional types) here can cause issues with the build.
 *
 * This change was initially made for Next.js 15, which specifies the second
 * argument as `RouteContext`, whereas Next.js 13 and 14 omit it and Next.js 12
 * provides a `NextApiResponse`, which is varies based on the execution
 * environment used (edge vs serverless).
 */
export type RequestHandler = (
  expectedReq: NextRequest,
  res: unknown,
) => Promise<Response>;

const isRecord = (val: unknown): val is Record<string, unknown> => {
  return typeof val === "object" && val !== null;
};

const isFunction = (val: unknown): val is (...args: unknown[]) => unknown => {
  return typeof val === "function";
};

const isNext12ApiResponse = (val: unknown): val is NextApiResponse => {
  return (
    isRecord(val) &&
    isFunction(val.setHeader) &&
    isFunction(val.status) &&
    isFunction(val.send)
  );
};

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
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): RequestHandler & {
  GET: RequestHandler;
  POST: RequestHandler;
  PUT: RequestHandler;
} => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      reqMethod: "GET" | "POST" | "PUT" | undefined,
      ...args: Parameters<RequestHandler>
    ) => {
      const [expectedReq, res] = args;
      const req = expectedReq as Either<NextApiRequest, NextRequest>;

      const getHeader = (key: string): string | null | undefined => {
        const header =
          typeof req.headers.get === "function"
            ? req.headers.get(key)
            : req.headers[key];

        return Array.isArray(header) ? header[0] : header;
      };

      return {
        body: async () => {
          if (typeof req.json === "function") {
            return await req.json();
          }

          if (req.body instanceof ReadableStream) {
            return await streamToJSON(req.body);
          }

          return req.body;
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
            const isProd = process.env.NODE_ENV === "production";
            return isProd;
          } catch (_err) {
            // no-op
          }

          return;
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
                host.includes("://")
                  ? host
                  : `${absoluteUrl.protocol}//${host}`,
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
            if (process.env.NODE_ENV === "development") {
              scheme = "http";
            }
          } catch (_err) {
            // no-op
          }

          const url = new URL(req.url as string, `${scheme}://${host}`);

          return url;
        },
        transformResponse: ({ body, headers, status }): Response => {
          /**
           * Carefully attempt to set headers and data on the response object
           * for Next.js 12 support.
           *
           * This also assumes that we're not using Next.js 15, where the `res`
           * object is repopulated as a `RouteContext` object. We expect these
           * methods to NOT be defined in Next.js 15.
           *
           * We could likely use `instanceof ServerResponse` to better check the
           * type of this, though Next.js 12 had issues with this due to not
           * instantiating the response correctly.
           */
          if (isNext12ApiResponse(res)) {
            for (const [key, value] of Object.entries(headers)) {
              res.setHeader(key, value);
            }

            res.status(status);
            res.send(body);

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
        experimentalTransformSyncRequest: async (data) => {
          // Support `return new Response()`
          const res = data as Response;

          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
          });

          return {
            headers: headers,
            status: res.status,
            body: await res.clone().text(),
          };
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

  /**
   * Ensure we have a non-variadic length to avoid issues with forced type
   * checking.
   */
  Object.defineProperty(fn, "length", { value: 1 });

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

async function streamToJSON(stream: ReadableStream): Promise<unknown> {
  const chunks = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
